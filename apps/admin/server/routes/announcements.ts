import { Elysia, t } from 'elysia'
import { forwardInternalBff } from '../lib/internal-bff'
import { requireAuth } from '../lib/middleware'

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) })

export const announcementsRoutes = new Elysia({ prefix: '/api' })
  .use(requireAuth)
  .get(
    '/announcements',
    ({ query }) => {
      const search = new URLSearchParams()
      if (query.status) search.set('status', query.status)
      if (query.type) search.set('type', query.type)
      if (query.q) search.set('q', query.q)
      if (query.language) search.set('language', query.language)
      if (query.withinDays) search.set('withinDays', query.withinDays)
      const suffix = search.size ? `?${search}` : ''
      return forwardInternalBff({ path: `/internal/admin/announcements${suffix}` })
    },
    {
      query: t.Object({
        status: t.Optional(t.String({ maxLength: 32 })),
        type: t.Optional(t.String({ maxLength: 32 })),
        q: t.Optional(t.String({ maxLength: 128 })),
        language: t.Optional(t.String({ maxLength: 16 })),
        withinDays: t.Optional(t.String({ maxLength: 8 })),
      }),
    },
  )
  .get(
    '/announcements/:id',
    ({ params }) =>
      forwardInternalBff({
        path: `/internal/admin/announcements/${encodeURIComponent(params.id)}`,
      }),
    { params: idParams },
  )
  .post('/announcements', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/announcements',
      body,
      operator: admin.operatorId,
    }),
  )
  .post('/announcements/import', ({ admin, body }) =>
    forwardInternalBff({
      method: 'POST',
      path: '/internal/admin/announcements/import',
      body,
      operator: admin.operatorId,
    }),
  )
  .put(
    '/announcements/:id',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'PUT',
        path: `/internal/admin/announcements/${encodeURIComponent(params.id)}`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .post(
    '/announcements/:id/publish',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/announcements/${encodeURIComponent(params.id)}/publish`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .post(
    '/announcements/:id/unpublish',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/announcements/${encodeURIComponent(params.id)}/unpublish`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
  .post(
    '/announcements/:id/archive',
    ({ admin, body, params }) =>
      forwardInternalBff({
        method: 'POST',
        path: `/internal/admin/announcements/${encodeURIComponent(params.id)}/archive`,
        body,
        operator: admin.operatorId,
      }),
    { params: idParams },
  )
