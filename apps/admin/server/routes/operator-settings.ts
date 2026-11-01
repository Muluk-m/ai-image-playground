import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

const keyParams = t.Object({ key: t.String({ minLength: 1, maxLength: 128 }) })

/** Operator settings are written only by BFF; Admin forwards authenticated requests. */
export const operatorSettingsRoutes = new Elysia({ prefix: '/api/operator-settings' })
  .use(requireAuth)
  .get('/', () => forwardInternalBff({ path: '/internal/admin/operator-config' }))
  .put(
    '/:key',
    ({ admin, params, body }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/operator-config/${encodeURIComponent(params.key)}`,
        body,
        operator: admin.operatorId,
      }),
    {
      params: keyParams,
      body: t.Object({
        value: t.Union([t.Boolean(), t.Numeric()]),
        reason: t.String({ minLength: 1, maxLength: 2000 }),
        expectedRevision: t.Numeric({ minimum: 0, multipleOf: 1 }),
      }),
    },
  )
  .delete(
    '/:key',
    ({ admin, params, query }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/operator-config/${encodeURIComponent(params.key)}?${new URLSearchParams(
          {
            reason: query.reason,
            expectedRevision: String(query.expectedRevision),
          },
        )}`,
        operator: admin.operatorId,
      }),
    {
      params: keyParams,
      query: t.Object({
        reason: t.String({ minLength: 1, maxLength: 2000 }),
        expectedRevision: t.Numeric({ minimum: 0, multipleOf: 1 }),
      }),
    },
  )
