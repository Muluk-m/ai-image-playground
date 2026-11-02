import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

export const modelRoutes = new Elysia({ prefix: '/api/models' })
  .use(requireAuth)
  .get('/', () => forwardInternalBff({ path: '/internal/admin/models' }))
  .put(
    '/:model',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/models/${encodeURIComponent(params.model)}`,
        body,
        operator: admin.operatorId,
      }),
    { body: t.Object({ active: t.Boolean() }) },
  )
