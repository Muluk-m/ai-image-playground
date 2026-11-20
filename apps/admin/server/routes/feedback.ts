import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })
const messageIdParams = t.Object({ messageId: t.String({ minLength: 1, maxLength: 128 }) })

export const feedbackRoutes = new Elysia({ prefix: '/api/feedback' })
  .use(requireAuth)
  .get(
    '/',
    ({ query }) => {
      const search = new URLSearchParams()
      if (query.filter) search.set('filter', query.filter)
      if (query.q) search.set('q', query.q)
      if (query.page !== undefined) search.set('page', String(query.page))
      const suffix = search.size ? `?${search}` : ''
      return forwardInternalBff({ path: `/internal/admin/feedback${suffix}` })
    },
    {
      query: t.Object({
        filter: t.Optional(t.String({ maxLength: 32 })),
        q: t.Optional(t.String({ maxLength: 128 })),
        page: t.Optional(t.Numeric({ minimum: 1, maximum: 1_000_000, multipleOf: 1 })),
      }),
    },
  )
  .get(
    '/attachments/:messageId',
    ({ params }) =>
      forwardInternalBff({
        path: `/internal/admin/feedback/attachments/${encodeURIComponent(params.messageId)}`,
        accept: 'image/*',
      }),
    { params: messageIdParams },
  )
  .get(
    '/:id',
    ({ params, query }) =>
      forwardInternalBff({
        path: `/internal/admin/feedback/${encodeURIComponent(params.id)}${query.before === undefined ? '' : `?before=${query.before}`}`,
      }),
    {
      params: idParams,
      query: t.Object({
        before: t.Optional(
          t.Numeric({ minimum: 1, maximum: 8_640_000_000_000_000, multipleOf: 1 }),
        ),
      }),
    },
  )
  .post(
    '/:id/replies',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/feedback/${encodeURIComponent(params.id)}/replies`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .patch(
    '/:id/status',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'PATCH',
        path: `/internal/admin/feedback/${encodeURIComponent(params.id)}/status`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
