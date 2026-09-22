import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })

export const inspirationsRoutes = new Elysia({ prefix: '/api' })
  .use(requireAuth)
  .get(
    '/inspirations',
    ({ query }) => {
      const search = new URLSearchParams()
      if (query.status) search.set('status', query.status)
      if (query.kind) search.set('kind', query.kind)
      if (query.q) search.set('q', query.q)
      const suffix = search.size ? `?${search}` : ''
      return forwardInternalBff({ path: `/internal/admin/inspirations${suffix}` })
    },
    {
      query: t.Object({
        status: t.Optional(t.String({ maxLength: 32 })),
        kind: t.Optional(t.String({ maxLength: 32 })),
        q: t.Optional(t.String({ maxLength: 128 })),
      }),
    },
  )
  .get(
    '/inspirations/:id',
    ({ params }) =>
      forwardInternalBff({ path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}` }),
    { params: idParams },
  )
  .post('/inspirations', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/inspirations',
      body,
      operator: admin.operatorId,
    }),
  )
  .put(
    '/inspirations/:id',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .delete(
    '/inspirations/:id',
    ({ admin, params }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}`,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .post(
    '/inspirations/:id/status',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}/status`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .post('/inspirations/uploads', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/inspirations/uploads',
      body,
      operator: admin.operatorId,
    }),
  )
  .get('/inspiration-categories', () =>
    forwardInternalBff({ path: '/internal/admin/inspiration-categories' }),
  )
  .post('/inspiration-categories', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/inspiration-categories',
      body,
      operator: admin.operatorId,
    }),
  )
  .put(
    '/inspiration-categories/:id',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/inspiration-categories/${encodeURIComponent(params.id)}`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .delete(
    '/inspiration-categories/:id',
    ({ admin, params }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/inspiration-categories/${encodeURIComponent(params.id)}`,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
