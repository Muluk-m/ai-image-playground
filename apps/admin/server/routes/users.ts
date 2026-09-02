import { PASSWORD_MAX_LENGTH, TASK_STATUSES, USERNAME_MAX_LENGTH } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getUserDetail, getUserTasks, listUsers } from '../lib/queries'
import { forwardUserOperation } from '../lib/users'

const VALID_STATUSES = ['all', ...TASK_STATUSES]

export const usersRoutes = new Elysia({ prefix: '/api/users' })
  .use(requireAuth)
  .get('/', ({ query }) => listUsers(query.q ?? ''), {
    query: t.Object({ q: t.Optional(t.String({ maxLength: 128 })) }),
  })
  .get(
    '/:id',
    async ({ params, status }) => {
      const detail = await getUserDetail(params.id)
      if (!detail) return status(404, { error: 'user_not_found' })
      return detail
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
  .get(
    '/:id/tasks',
    ({ params, query }) => {
      const requestedStatus = query.status ?? ''
      const statusFilter = VALID_STATUSES.includes(requestedStatus) ? requestedStatus : 'all'
      return getUserTasks(params.id, statusFilter, query.cursor || undefined)
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      query: t.Object({
        status: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    },
  )
  .post('/', ({ body }) => forwardUserOperation({ method: 'POST', path: '/', body }), {
    body: t.Object({
      username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
      password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
    }),
  })
  .patch(
    '/:id',
    ({ params, body }) =>
      forwardUserOperation({ method: 'PATCH', path: `/${encodeURIComponent(params.id)}`, body }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({ status: t.String({ minLength: 1, maxLength: 16 }) }),
    },
  )
  .post(
    '/:id/reset-password',
    ({ params, body }) =>
      forwardUserOperation({
        method: 'POST',
        path: `/${encodeURIComponent(params.id)}/reset-password`,
        body,
      }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({ password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }) }),
    },
  )
  .post(
    '/:id/revoke-sessions',
    ({ params }) =>
      forwardUserOperation({
        method: 'POST',
        path: `/${encodeURIComponent(params.id)}/revoke-sessions`,
      }),
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
