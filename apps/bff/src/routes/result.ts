import type { ResultResponse, TaskErrorType } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { extractMeta, resolveImageBytesRef } from '../lib/extractImages'
import { jsonResponse } from '../lib/gzipResponse'
import { isStoredImageRef } from '../lib/imageArchive'
import { objectStore } from '../lib/objectStore'
import { asQueueProvider } from '../lib/queueProvider'
import { taskAccessWhere } from '../lib/task-access'
import { requireUserOrService } from '../lib/user-auth'

const outputRouteOptions = {
  params: t.Object({
    id: t.String(),
    index: t.String(),
  }),
}

export const resultRoutes = new Elysia()
  .use(requireUserOrService)
  // 1) 元信息端点：返回图片列表 + actual_params + raw_image_urls；不含像素字节
  .get(
    '/v1/queue/requests/:id',
    async ({ params, status, request, authUser, serviceIdentity }) => {
      const [task] = await db
        .select()
        .from(schema.tasks)
        .where(taskAccessWhere(params.id, authUser?.id ?? null, serviceIdentity))
        .limit(1)

      if (!task) return status(404, { error: 'task_not_found' })

      if (task.status === 'completed') {
        const provider = asQueueProvider(task.provider)
        if (!provider) return status(500, { error: `unknown_provider:${task.provider}` })
        const meta = extractMeta(provider, task.result_payload)
        const body: ResultResponse = {
          request_id: task.id,
          status: 'completed',
          images: meta.images,
          ...(meta.actual_params ? { actual_params: meta.actual_params } : {}),
          ...(meta.raw_image_urls ? { raw_image_urls: meta.raw_image_urls } : {}),
        }
        return jsonResponse(body, request)
      }
      if (task.status === 'failed') {
        const body: ResultResponse = {
          request_id: task.id,
          status: 'failed',
          error: {
            message: task.error_message ?? 'unknown',
            type: (task.error_type ?? 'unknown') as TaskErrorType,
          },
        }
        return jsonResponse(body, request)
      }
      if (task.status === 'cancelled') {
        return jsonResponse({ request_id: task.id, status: 'cancelled' } as ResultResponse, request)
      }
      return status(425, { error: 'task_not_ready' })
    },
    { params: t.Object({ id: t.String() }) },
  )
  // 2) 二进制端点：按 index 返回原始字节，跳过 base64 + JSON 双重开销。
  //    /image/ 是 /output/ 的历史别名，两条路径同一个处理器。
  .get(
    '/v1/queue/requests/:id/output/:index',
    ({ params, request, authUser, serviceIdentity }) =>
      serveOutput(params, request, authUser?.id ?? null, serviceIdentity),
    outputRouteOptions,
  )
  .get(
    '/v1/queue/requests/:id/image/:index',
    ({ params, request, authUser, serviceIdentity }) =>
      serveOutput(params, request, authUser?.id ?? null, serviceIdentity),
    outputRouteOptions,
  )
  .get(
    '/v1/queue/requests/:id/input-image/:index',
    async ({ params, status, authUser, serviceIdentity }) => {
      const [task] = await db
        .select({
          provider: schema.tasks.provider,
          request_payload: schema.tasks.request_payload,
          user_id: schema.tasks.user_id,
        })
        .from(schema.tasks)
        .where(taskAccessWhere(params.id, authUser?.id ?? null, serviceIdentity))
        .limit(1)
      if (!task) return status(404, { error: 'task_not_found' })

      const idx = Number(params.index)
      if (!Number.isInteger(idx) || idx < 0) return status(400, { error: 'bad_index' })
      const input = resolveInputImage(task.provider, task.request_payload, idx)
      if (!input) return status(404, { error: 'image_not_found' })

      const headers = {
        'content-type': input.mime,
        'cache-control': `${task.user_id === null ? 'public' : 'private'}, max-age=31536000, immutable`,
      } as const
      if (input.kind === 'b64') {
        return new Response(Buffer.from(input.data, 'base64'), { headers })
      }
      try {
        return new Response(await objectStore().read(input.data), { headers })
      } catch {
        return status(502, { error: 'object_storage_error' })
      }
    },
    {
      params: t.Object({
        id: t.String(),
        index: t.String(),
      }),
    },
  )

async function serveOutput(
  params: { id: string; index: string },
  request: Request,
  userId: string | null,
  serviceIdentity: boolean | undefined,
): Promise<Response> {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(taskAccessWhere(params.id, userId, serviceIdentity))
    .limit(1)
  if (!task || task.status !== 'completed')
    return Response.json({ error: 'not_ready' }, { status: 404 })
  const provider = asQueueProvider(task.provider)
  if (!provider)
    return Response.json({ error: `unknown_provider:${task.provider}` }, { status: 500 })
  const idx = Number(params.index)
  if (!Number.isInteger(idx) || idx < 0)
    return Response.json({ error: 'bad_index' }, { status: 400 })

  const ref = resolveImageBytesRef(provider, task.result_payload, idx)
  if (!ref) return Response.json({ error: 'image_not_found' }, { status: 404 })

  // Ownership is immutable. Owned bytes must not enter shared caches.
  const cacheControl = `${task.user_id === null ? 'public' : 'private'}, max-age=31536000, immutable`
  const range = request.headers.get('range')

  if (ref.kind === 'b64') {
    return mediaResponse(Buffer.from(ref.data, 'base64'), ref.mime, cacheControl, range)
  }
  if (ref.kind === 'object') {
    try {
      return mediaResponse(await objectStore().read(ref.data), ref.mime, cacheControl, range)
    } catch {
      return Response.json({ error: 'object_storage_error' }, { status: 502 })
    }
  }
  // kind === 'url'：上游返回了 http 地址，BFF 现拉回来透传给客户端
  const upstream = await fetch(ref.data)
  if (!upstream.ok || !upstream.body) {
    return Response.json({ error: `upstream_image_${upstream.status}` }, { status: 502 })
  }
  const mime = upstream.headers.get('content-type') ?? ref.mime
  if (!isSeekable(mime)) {
    return new Response(upstream.body, {
      headers: { 'content-type': mime, 'cache-control': cacheControl },
    })
  }
  return mediaResponse(new Uint8Array(await upstream.arrayBuffer()), mime, cacheControl, range)
}

/** `<video>` 拖进度条要靠 Range；图片全量返回即可，不必声明可寻址。 */
function isSeekable(mime: string): boolean {
  return mime.startsWith('video/')
}

function mediaResponse(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  cacheControl: string,
  range: string | null,
): Response {
  const headers: Record<string, string> = { 'content-type': mime, 'cache-control': cacheControl }
  if (!isSeekable(mime)) return new Response(bytes, { headers })

  headers['accept-ranges'] = 'bytes'
  const span = range === null ? null : parseByteRange(range, bytes.length)
  if (span === null) return new Response(bytes, { headers })
  if (span === 'unsatisfiable') {
    headers['content-range'] = `bytes */${bytes.length}`
    return new Response(null, { status: 416, headers })
  }
  headers['content-range'] = `bytes ${span.start}-${span.end}/${bytes.length}`
  return new Response(bytes.slice(span.start, span.end + 1), { status: 206, headers })
}

/**
 * 单段 `bytes=` 区间。多段与不认识的写法返回 null，按整份 200 回 —— 规范允许，
 * 播放器拿到 200 会退回整段下载而不是报错。
 */
function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

type InputImage =
  | { kind: 'b64'; data: string; mime: string }
  | { kind: 'object'; data: string; mime: string }

function resolveInputImage(provider: string, payload: unknown, index: number): InputImage | null {
  if (!payload || typeof payload !== 'object') return null
  const request = payload as Record<string, unknown>
  const archived: unknown[] = Array.isArray(request.input_images) ? [...request.input_images] : []
  if (request.mask !== undefined) archived.push(request.mask)
  if (archived.length > 0) {
    const value = archived[index]
    if (isStoredImageRef(value)) {
      return { kind: 'object', data: value.object, mime: value.mime }
    }
    return typeof value === 'string' ? parseDataUrl(value) : null
  }
  if (provider !== 'gemini' || !Array.isArray(request.contents)) return null
  const inlineImages: InputImage[] = []
  for (const content of request.contents) {
    if (!content || typeof content !== 'object' || !('parts' in content)) continue
    const parts = content.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue
      const inline =
        'inlineData' in part ? part.inlineData : 'inline_data' in part ? part.inline_data : null
      if (!inline || typeof inline !== 'object') continue
      const encoded = 'data' in inline ? inline.data : undefined
      const mime =
        'mimeType' in inline
          ? inline.mimeType
          : 'mime_type' in inline
            ? inline.mime_type
            : undefined
      if (typeof encoded === 'string' && typeof mime === 'string') {
        inlineImages.push({ kind: 'b64', data: encoded, mime })
      }
    }
  }
  return inlineImages[index] ?? null
}

function parseDataUrl(dataUrl: string | undefined): InputImage | null {
  if (!dataUrl) return null
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  return {
    kind: 'b64',
    data: match[2]!,
    mime: match[1]!,
  }
}
