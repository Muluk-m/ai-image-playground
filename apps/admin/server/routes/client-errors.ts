import { Elysia, t } from 'elysia'
import { parseRange } from '../../contracts'
import { getClientErrorEvents, getClientErrors } from '../lib/client-errors'
import { requireAuth } from '../lib/middleware'

// 只读：上报写入发生在 BFF 的 /api/client-errors。
export const clientErrorsRoutes = new Elysia({ prefix: '/api' })
  .use(requireAuth)
  .get('/client-errors', ({ query }) => getClientErrors(parseRange(query.range)), {
    query: t.Object({ range: t.Optional(t.String()) }),
  })
  .get(
    '/client-errors/:fingerprint',
    ({ params, query }) => getClientErrorEvents(params.fingerprint, parseRange(query.range)),
    {
      params: t.Object({ fingerprint: t.String({ pattern: '^[0-9a-f]{16}$' }) }),
      query: t.Object({ range: t.Optional(t.String()) }),
    },
  )
