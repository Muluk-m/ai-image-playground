import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  deleteGeneration,
  deleteGenerationOutput,
  type GenerationCursor,
  listGenerations,
  readGeneration,
} from '../lib/generations'
import { ObjectStorageError } from '../lib/imageArchive'
import { log } from '../lib/logger'
import { ObjectStoreHttpError } from '../lib/objectStore'
import { MediaError } from '../lib/projectMedia'
import { promoteCanvasCandidate } from '../lib/promoteCanvasCandidate'
import { resolveAuthUser } from '../lib/user-auth'

function explicitRetryable(error: Error): boolean | undefined {
  const flagged = (error as { retryable?: unknown }).retryable
  return typeof flagged === 'boolean' ? flagged : undefined
}

/** 存储闪断和显式标记可重试。标了 retryable:false 的，以及看不出是存储故障的错误，不让客户端空转。 */
function storageRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const flagged = explicitRetryable(error)
  if (flagged === false) return false
  if (flagged === true) return true
  if (error instanceof ObjectStorageError) return true
  if (error instanceof ObjectStoreHttpError) return error.status >= 500 || error.status === 429
  const httpStatus = /^Object (?:read|upload|metadata) failed \((\d{3})\)$/.exec(error.message)
  if (!httpStatus) return false
  const status = Number(httpStatus[1])
  return status >= 500 || status === 429
}

function promoteFailure(error: unknown): {
  status: 404 | 409 | 413 | 422 | 503
  body: { error: string; retryable?: true }
} {
  if (error instanceof MediaError) {
    if (
      error.status === 503 ||
      error.message === 'media_pending' ||
      error.message === 'media_deleting'
    ) {
      return { status: 503, body: { error: error.message, retryable: true } }
    }
    return { status: error.status, body: { error: error.message } }
  }
  const retryable = storageRetryable(error)
  log.warn(
    { event: 'canvas_promote.unavailable', retryable, err: String(error) },
    retryable ? 'canvas promote will be retried' : 'canvas promote failed',
  )
  return {
    status: 503,
    body: {
      error: retryable ? 'storage_unavailable' : 'promote_unavailable',
      ...(retryable ? { retryable: true as const } : {}),
    },
  }
}

export const generationRoutes = new Elysia()
  .use(resolveAuthUser)
  .onBeforeHandle(({ set }) => {
    set.headers['cache-control'] = 'private, no-store'
    if (!isCapabilityEnabled('accounts:sync')) return capabilityUnavailable('accounts:sync')
  })
  .get(
    '/api/generations',
    async ({ authUser, query, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      let cursor: GenerationCursor | undefined
      if (query.cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString())
          if (
            !Number.isSafeInteger(decoded.createdAt) ||
            decoded.createdAt < 0 ||
            decoded.createdAt > 253402300799999 ||
            typeof decoded.id !== 'string' ||
            !/^[0-9a-f-]{36}$/.test(decoded.id)
          )
            throw new Error('cursor')
          cursor = decoded
        } catch {
          return status(400, { error: 'invalid_generation_cursor' })
        }
      }
      return listGenerations(authUser.id, query.limit ?? 50, cursor)
    },
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
        cursor: t.Optional(t.String({ maxLength: 256 })),
      }),
    },
  )
  .post(
    '/api/generations/:id/promote',
    async ({ authUser, params, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        const result = await promoteCanvasCandidate(authUser.id, params.id, body.outputIndex ?? 0)
        if (!result.ok) {
          return result.error === 'candidate_expired'
            ? status(409, { error: 'candidate_expired' })
            : status(404, { error: 'generation_not_found' })
        }
        return result.detail
      } catch (error) {
        const failure = promoteFailure(error)
        return status(failure.status, failure.body)
      }
    },
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        outputIndex: t.Optional(t.Integer({ minimum: 0, maximum: 1000 })),
      }),
    },
  )
  .get(
    '/api/generations/:id',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return (
        (await readGeneration(authUser.id, params.id)) ??
        status(404, { error: 'generation_not_found' })
      )
    },
    { params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  .delete(
    '/api/generations/:id',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return (await deleteGeneration(authUser.id, params.id))
        ? status(204)
        : status(404, { error: 'generation_not_found' })
    },
    { params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  .delete(
    '/api/generations/:id/outputs/:position',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const result = await deleteGenerationOutput(authUser.id, params.id, params.position)
      if (result === 'not_found') return status(404, { error: 'generation_output_not_found' })
      return { generationDeleted: result === 'generation_deleted' }
    },
    {
      params: t.Object({
        id: t.String({ format: 'uuid' }),
        position: t.Numeric({ minimum: 0, maximum: 1000, multipleOf: 1 }),
      }),
    },
  )
