import { Elysia, t } from 'elysia'
import {
  clearOperatorConfig,
  listOperatorConfig,
  OperatorConfigError,
  refreshOperatorConfig,
  setOperatorConfig,
} from '../lib/operator-config-overrides'
import { requireInternalService } from '../lib/user-auth'

const revision = t.Integer({ minimum: 0 })
const key = t.String({ minLength: 1, maxLength: 128 })
const reason = t.String({ minLength: 1, maxLength: 1000 })

export const internalOperatorConfigRoutes = new Elysia({
  prefix: '/internal/admin/operator-config',
})
  .use(requireInternalService)
  .onError({ as: 'scoped' }, ({ error, set }) => {
    if (!(error instanceof OperatorConfigError)) return
    set.status = error.status
    return { error: error.code, ...(error.details ? { details: error.details } : {}) }
  })
  .get('/', () => listOperatorConfig())
  .post('/refresh', async () => ({ revision: await refreshOperatorConfig() }))
  .put(
    '/:key',
    async ({ params, body, request }) => {
      const operatorId = request.headers.get('x-admin-operator')?.trim() || 'admin'
      await setOperatorConfig({
        key: params.key,
        value: body.value,
        expectedRevision: body.expectedRevision,
        operatorId,
        reason: body.reason,
      })
      return listOperatorConfig()
    },
    {
      params: t.Object({ key }),
      body: t.Object({
        value: t.Union([t.Boolean(), t.Integer()]),
        expectedRevision: revision,
        reason,
      }),
    },
  )
  .delete(
    '/:key',
    async ({ params, query, request }) => {
      await clearOperatorConfig({
        key: params.key,
        expectedRevision: query.expectedRevision,
        operatorId: request.headers.get('x-admin-operator')?.trim() || 'admin',
        reason: query.reason,
      })
      return listOperatorConfig()
    },
    {
      params: t.Object({ key }),
      query: t.Object({
        expectedRevision: t.Integer({ minimum: 0 }),
        reason,
      }),
    },
  )
