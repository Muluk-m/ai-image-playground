import { Elysia } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

export const agentModelRoutes = new Elysia({ prefix: '/api/agent-models' })
  .use(requireAuth)
  .get('/', () => forwardInternalBff({ path: '/internal/admin/agent-models' }))
  .post('/probe', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/agent-models/probe',
      body,
      operator: admin.operatorId,
    }),
  )
  .put('/', ({ admin, body }) =>
    forwardInternalBff({
      method: 'PUT',
      path: '/internal/admin/agent-models',
      body,
      operator: admin.operatorId,
    }),
  )
