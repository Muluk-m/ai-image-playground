import { Elysia } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

export const gptDirectRoutes = new Elysia({ prefix: '/api/gpt-direct' })
  .use(requireAuth)
  .get('/', ({ request }) => {
    const days = new URL(request.url).searchParams.get('days') ?? '7'
    return forwardInternalBff({
      path: `/internal/admin/gpt-direct?days=${encodeURIComponent(days)}`,
    })
  })
  .post('/keys', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/gpt-direct/keys',
      body,
      operator: admin.operatorId,
    }),
  )
  .post('/keys/order', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/gpt-direct/keys/order',
      body,
      operator: admin.operatorId,
    }),
  )
  .patch('/keys/:id', ({ admin, body, params }) =>
    forwardInternalBff({
      method: 'PATCH',
      path: `/internal/admin/gpt-direct/keys/${encodeURIComponent(params.id)}`,
      body,
      operator: admin.operatorId,
    }),
  )
  .delete('/keys/:id', ({ admin, params }) =>
    forwardInternalBff({
      method: 'DELETE',
      path: `/internal/admin/gpt-direct/keys/${encodeURIComponent(params.id)}`,
      operator: admin.operatorId,
    }),
  )
  .post('/keys/:fingerprint/restore', ({ admin, params }) =>
    forwardInternalBff({
      method: 'POST',
      path: `/internal/admin/gpt-direct/keys/${encodeURIComponent(params.fingerprint)}/restore`,
      operator: admin.operatorId,
    }),
  )
