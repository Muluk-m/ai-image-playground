import { createDb, type DbHandle } from '@image-playground/db'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { requireAuth } from '../lib/middleware'
import { createTaskMetaCache, type TaskMetaCache } from '../lib/task-meta-cache'

interface TaskMeta {
  id: string
}

// Lazily initialize a pool so test environment setup can precede configuration capture.
const _handles = new Map<string, DbHandle>()
function getHandle(): DbHandle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let h = _handles.get(url)
  if (!h) {
    h = createDb(url)
    _handles.set(url, h)
  }
  return h
}

const _caches = new Map<string, TaskMetaCache<TaskMeta>>()
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
          .select({ id: schema.tasks.id })
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

async function proxyTaskImage(
  taskId: string,
  imageType: 'image' | 'input-image',
  index: string,
): Promise<Response> {
  const meta = await getTaskMetaCache().get(taskId)
  if (!meta) {
    return Response.json({ error_code: 'task_not_found' }, { status: 404 })
  }

  const bffBase = (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(
    /\/+$/,
    '',
  )
  const internalApiToken = config.auth.internalApiToken
  const upstream = `${bffBase}/v1/queue/requests/${taskId}/${imageType}/${index}`
  const res = await fetch(upstream, {
    headers: internalApiToken ? { authorization: `Bearer ${internalApiToken}` } : undefined,
  })
  if (!res.ok) {
    return Response.json(
      { error_code: 'upstream_failed', upstream_status: res.status },
      { status: res.status },
    )
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'private, max-age=600',
    },
  })
}

export const imagesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks/:id/image',
    ({ params, query }) => proxyTaskImage(params.id, 'image', query.idx ?? '0'),
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )
  .get(
    '/api/tasks/:id/input-image',
    ({ params, query }) => proxyTaskImage(params.id, 'input-image', query.idx ?? '0'),
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )
