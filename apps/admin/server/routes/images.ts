import { createDb } from '@image-playground/db'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { requireAuth } from '../lib/middleware'
import { createTaskMetaCache } from '../lib/task-meta-cache'

interface TaskMeta {
  provider: string
  model: string
}

// 懒初始化 readonly handle + cache：跟 queries.ts 的 getHandle 类似 pattern，
// 避免 module 顶层 createDb 在 test setEnv 之前固化到错的 DATABASE_URL。
type Handle = ReturnType<typeof createDb>
const _handles = new Map<string, Handle>()
function getHandle(): Handle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let h = _handles.get(url)
  if (!h) {
    h = createDb(url, { readonly: true })
    _handles.set(url, h)
  }
  return h
}

const _caches = new Map<string, ReturnType<typeof createTaskMetaCache<TaskMeta>>>()
function getTaskMetaCache() {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let c = _caches.get(url)
  if (!c) {
    c = createTaskMetaCache<TaskMeta>({
      maxEntries: 200,
      ttlMs: 30_000,
      load: async (taskId) => {
        const { db, schema } = getHandle()
        const rows = await db
          .select({ provider: schema.tasks.provider, model: schema.tasks.model })
          .from(schema.tasks)
          .where(eq(schema.tasks.id, taskId))
          .limit(1)
        return rows[0] ?? null
      },
    })
    _caches.set(url, c)
  }
  return c
}

export const imagesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks/:id/image',
    async ({ params, query, set }) => {
      const meta = await getTaskMetaCache().get(params.id)
      if (!meta) {
        set.status = 404
        return { error_code: 'task_not_found' }
      }
      const idx = query.idx ?? '0'
      // 读 env 而非 config 单例：tests 间会 setEnv 切换 BFF_INTERNAL_URL，config 在 import
      // 时固化、跟随首个 import 它的 module。改为运行时读环境，保持线上行为不变（线上启动后 env 不变）。
      const bffBase = (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(
        /\/+$/,
        '',
      )
      const upstream = `${bffBase}/v1/queue/requests/${params.id}/image/${idx}`
      const res = await fetch(upstream)
      if (!res.ok) {
        set.status = res.status
        return { error_code: 'upstream_failed', upstream_status: res.status }
      }
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      return new Response(res.body, {
        status: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'private, max-age=600',
        },
      })
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )
  .get(
    '/api/tasks/:id/input-image',
    async ({ params, query, set }) => {
      const { db, schema } = getHandle()
      const rows = await db
        .select({
          provider: schema.tasks.provider,
          request_payload: schema.tasks.request_payload,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, params.id))
        .limit(1)
      const task = rows[0]
      if (!task) {
        set.status = 404
        return { error_code: 'task_not_found' }
      }
      if (task.provider !== 'gemini') {
        set.status = 422
        return { error_code: 'input_image_not_archived' }
      }
      const idx = Number(query.idx ?? '0')
      const bytes = extractGeminiInputImage(task.request_payload, idx)
      if (!bytes) {
        set.status = 422
        return { error_code: 'input_image_not_archived' }
      }
      return new Response(bytes.data as BlobPart, {
        status: 200,
        headers: {
          'content-type': bytes.mime,
          'cache-control': 'private, max-age=3600',
        },
      })
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )

function extractGeminiInputImage(
  payload: unknown,
  idx: number,
): { data: Uint8Array; mime: string } | null {
  // 前端是把 input_images 作为 data URL 数组发给 BFF；BFF 转 Gemini 格式发给上游。
  // tasks.request_payload 存的是前端原始 SubmitRequest，所以 input_images: string[]
  // 优先尝试，元素是 'data:image/png;base64,...' 形式。
  const inputImages = (payload as { input_images?: unknown } | undefined)?.input_images
  if (Array.isArray(inputImages) && typeof inputImages[idx] === 'string') {
    return parseDataUrl(inputImages[idx] as string)
  }
  return null
}

function parseDataUrl(dataUrl: string): { data: Uint8Array; mime: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  const mime = match[1]!
  const base64 = match[2]!
  try {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { data: bytes, mime }
  } catch {
    return null
  }
}
