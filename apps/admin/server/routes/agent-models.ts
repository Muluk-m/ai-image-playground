import { Elysia } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

export const agentModelRoutes = new Elysia({ prefix: '/api/agent-models' })
  .use(requireAuth)
  .get('/', () => forwardInternalBff({ path: '/internal/admin/agent-models' }))
  .put('/', ({ admin, body }) =>
    forwardInternalBff({
      method: 'PUT',
      path: '/internal/admin/agent-models',
      body,
      operator: admin.operatorId,
    }),
  )
