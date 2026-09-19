import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { type GenerationCursor, listGenerations, readGeneration } from '../lib/generations'
import { resolveAuthUser } from '../lib/user-auth'

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
