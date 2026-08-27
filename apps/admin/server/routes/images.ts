import { sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { getAdminRead } from '../lib/handle'
import { requireAuth } from '../lib/middleware'
import { createTaskMetaCache } from '../lib/task-meta-cache'

interface TaskMeta {
  provider: string
  model: string
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
        const db = await getAdminRead()
        const rows = await db.all(sql`
          SELECT provider, model FROM tasks WHERE id = ${taskId} LIMIT 1
        `)
        const row = rows[0]
        if (!row) return null
        return { provider: String(row.provider), model: String(row.model) }
      },
    })
    _caches.set(url, c)
  }
  return c
}

function bffBase(): string {
  return (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(/\/+$/, '')
}

async function proxyBff(path: string, set: { status?: number | string }) {
  const res = await fetch(`${bffBase()}${path}`)
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
      return proxyBff(`/v1/queue/requests/${params.id}/image/${idx}`, set)
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )
  .get(
    '/api/tasks/:id/input-image',
    async ({ params, query, set }) => {
      const db = await getAdminRead()
      const rows = await db.all(sql`
        SELECT request_payload FROM tasks WHERE id = ${params.id} LIMIT 1
      `)
      const task = rows[0]
      if (!task) {
        set.status = 404
        return { error_code: 'task_not_found' }
      }

      const idx = Number(query.idx ?? '0')
      const entry = extractInputImageEntry(task.request_payload, idx)
      const legacyImage = typeof entry === 'string' ? parseDataUrl(entry) : null
      if (legacyImage) {
        return imageResponse(legacyImage.data, legacyImage.mime)
      }

      const blobIdx = extractBlobIndex(entry)
      if (blobIdx !== null) {
        const res = await fetch(`${bffBase()}/v1/queue/requests/${params.id}/input/${blobIdx}`)
        if (res.ok) {
          const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
          return new Response(res.body, {
            status: 200,
            headers: {
              'content-type': contentType,
              'cache-control': 'private, max-age=3600',
            },
          })
        }
      }

      set.status = 422
      return { error_code: 'input_image_not_archived' }
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )

function extractInputImageEntry(payload: unknown, idx: number): unknown {
  if (!Number.isInteger(idx) || idx < 0) return undefined
  const parsed = typeof payload === 'string' ? safeJson(payload) : payload
  const inputImages = (parsed as { input_images?: unknown } | undefined)?.input_images
  return Array.isArray(inputImages) ? inputImages[idx] : undefined
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function extractBlobIndex(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null
  const idx = (value as Record<string, unknown>).$blob
  return typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 ? idx : null
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

function imageResponse(data: Uint8Array, mime: string): Response {
  return new Response(data as BlobPart, {
    status: 200,
    headers: {
      'content-type': mime,
      'cache-control': 'private, max-age=3600',
    },
  })
}
