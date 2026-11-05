import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

const id = t.String({ minLength: 1, maxLength: 64 })
const body = t.Object({ apiKey: t.Any() })

/** Upstream secrets are written only by BFF. Admin forwards the authenticated operator. */
export const upstreamSecretRoutes = new Elysia({ prefix: '/api/upstream-secrets' })
  .use(requireAuth)
  .get('/', () => forwardInternalBff({ path: '/internal/admin/upstream-secrets' }))
  .put(
    '/:id',
    ({ admin, params, body: payload }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/upstream-secrets/${encodeURIComponent(params.id)}`,
        body: payload,
        operator: admin.operatorId,
      }),
    { params: t.Object({ id }), body },
  )
  .delete(
    '/:id',
    ({ admin, params }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/upstream-secrets/${encodeURIComponent(params.id)}`,
        operator: admin.operatorId,
      }),
    { params: t.Object({ id }) },
  )
  .post(
    '/:id/test',
    ({ params, body: payload }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/upstream-secrets/${encodeURIComponent(params.id)}/test`,
        body: payload,
      }),
    { params: t.Object({ id }), body },
  )
