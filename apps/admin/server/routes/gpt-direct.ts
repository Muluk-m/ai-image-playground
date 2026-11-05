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
  .post('/keys/:fingerprint/restore', ({ admin, params }) =>
    forwardInternalBff({
      method: 'POST',
      path: `/internal/admin/gpt-direct/keys/${encodeURIComponent(params.fingerprint)}/restore`,
      operator: admin.operatorId,
    }),
  )
