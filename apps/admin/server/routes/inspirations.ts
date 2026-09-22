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
  .post('/inspirations', ({ body }) =>
    forwardInternalBff({ method: 'POST', path: '/internal/admin/inspirations', body }),
  )
  .put(
    '/inspirations/:id',
    ({ body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}`,
        body,
      }),
    { params: idParams },
  )
  .delete(
    '/inspirations/:id',
    ({ params }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}`,
      }),
    { params: idParams },
  )
  .post(
    '/inspirations/:id/status',
    ({ body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/inspirations/${encodeURIComponent(params.id)}/status`,
        body,
      }),
    { params: idParams },
  )
  .post('/inspirations/uploads', ({ body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/inspirations/uploads',
      body,
    }),
  )
  .get('/inspiration-categories', () =>
    forwardInternalBff({ path: '/internal/admin/inspiration-categories' }),
  )
  .post('/inspiration-categories', ({ body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/inspiration-categories',
      body,
    }),
  )
  .put(
    '/inspiration-categories/:id',
    ({ body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/inspiration-categories/${encodeURIComponent(params.id)}`,
        body,
      }),
    { params: idParams },
  )
  .delete(
    '/inspiration-categories/:id',
    ({ params }) =>
      forwardInternalBff({
        method: 'DELETE',
        path: `/internal/admin/inspiration-categories/${encodeURIComponent(params.id)}`,
      }),
    { params: idParams },
  )
