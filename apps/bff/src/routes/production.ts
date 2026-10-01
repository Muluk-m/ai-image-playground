import { Elysia, t } from 'elysia'
import {
  ProductionError,
  readProduction,
  restoreProduction,
  writeProduction,
} from '../lib/agent/production'
import { badRequestOnValidation } from '../lib/http'
import { resolveAuthUser } from '../lib/user-auth'

export const productionRoutes = new Elysia()
  .use(badRequestOnValidation())
  .use(resolveAuthUser)
  .onError(({ error, status }) => {
    if (error instanceof ProductionError)
      return status(
        error.code === 'production_conflict' || error.code === 'production_operation_reused'
          ? 409
          : error.code === 'production_invalid'
            ? 400
            : 404,
        { error: error.code, ...(error.current ? { current: error.current } : {}) },
      )
  })
  .get('/api/agent/conversations/:id/production', async ({ params, query, authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    const record = await readProduction(params.id, authUser.id)
    return {
      document: record?.document ?? null,
      history: query.history === 'true' ? (record?.history ?? []) : [],
    }
  })
  .put(
    '/api/agent/conversations/:id/production',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await writeProduction(params.id, authUser.id, body, 'user')
      return { document: record.document, history: record.history }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 0 }),
        content: t.Object({
          title: t.String({ maxLength: 200 }),
          setting: t.String({ maxLength: 100000 }),
          outline: t.String({ maxLength: 100000 }),
          scenes: t.Array(
            t.Object({
              id: t.String({ minLength: 1, maxLength: 128 }),
              title: t.String({ maxLength: 200 }),
              body: t.String({ maxLength: 100000 }),
            }),
            { maxItems: 100 },
          ),
        }),
      }),
    },
  )

  .post(
    '/api/agent/conversations/:id/production/restore',
    async ({ params, body, authUser, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const record = await restoreProduction(params.id, authUser.id, body)
      return { document: record.document, history: record.history }
    },
    {
      body: t.Object({
        operationId: t.String({ minLength: 1, maxLength: 128 }),
        baseRevision: t.Integer({ minimum: 0 }),
        revision: t.Integer({ minimum: 1 }),
      }),
    },
  )
