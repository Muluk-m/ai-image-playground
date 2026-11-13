import {
  ADMIN_USER_NOTE_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  TASK_STATUSES,
  USERNAME_MAX_LENGTH,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getUserDetail, getUserKpis, getUserTasks, listUsers } from '../lib/queries'
import { forwardUserOperation } from '../lib/users'

const VALID_STATUSES = ['all', ...TASK_STATUSES]

export const usersRoutes = new Elysia({ prefix: '/api/users' })
  .use(requireAuth)
  .get(
    '/',
    ({ query, status }) => {
      if (query.status !== undefined && query.status !== 'active' && query.status !== 'disabled')
        return status(400, { error: '无效的用户状态' })
      const page = query.page === undefined ? undefined : Number(query.page)
      const pageSize = query.pageSize === undefined ? undefined : Number(query.pageSize)
      if (
        (query.page !== undefined && (!Number.isInteger(page) || page! < 1 || page! > 10_000)) ||
        (query.pageSize !== undefined && pageSize !== 50 && pageSize !== 100)
      )
        return status(400, { error: '无效的分页' })
      const numberOr = (value: string | undefined) =>
        value === undefined ? undefined : Number(value)
      const registeredFrom = numberOr(query.registeredFrom)
      const registeredTo = numberOr(query.registeredTo)
      const activeFrom = numberOr(query.activeFrom)
      const activeTo = numberOr(query.activeTo)
      for (const value of [registeredFrom, registeredTo, activeFrom, activeTo]) {
        if (value !== undefined && !Number.isSafeInteger(value))
          return status(400, { error: '无效的时间范围' })
      }
      const sort =
        query.sort === 'created' || query.sort === 'login' || query.sort === 'activity'
          ? query.sort
          : undefined
      if (query.sort !== undefined && !sort) return status(400, { error: '无效的排序' })
      return listUsers(query.q ?? '', {
        status: query.status,
        registeredFrom,
        registeredTo,
        activeFrom,
        activeTo,
        sort,
        dir: query.dir === 'asc' ? 'asc' : query.dir === 'desc' ? 'desc' : undefined,
        page,
        pageSize: pageSize === 100 ? 100 : pageSize === 50 ? 50 : undefined,
      })
    },
    {
      query: t.Object({
        q: t.Optional(t.String({ maxLength: 128 })),
        status: t.Optional(t.String()),
        registeredFrom: t.Optional(t.String()),
        registeredTo: t.Optional(t.String()),
        activeFrom: t.Optional(t.String()),
        activeTo: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        dir: t.Optional(t.String()),
        page: t.Optional(t.String()),
        pageSize: t.Optional(t.String()),
      }),
    },
  )
  .get('/kpis', ({ query }) => getUserKpis(Date.now(), query.fresh === '1'), {
    query: t.Object({ fresh: t.Optional(t.String()) }),
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
  .post(
    '/',
    ({ admin, body }) =>
      forwardUserOperation({
        method: 'POST',
        path: '/',
        operatorId: admin.operatorId,
        body: { ...body, operatorId: admin.operatorId },
      }),
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .patch(
    '/:id',
    ({ admin, params, body }) =>
      forwardUserOperation({
        method: 'PATCH',
        path: `/${encodeURIComponent(params.id)}`,
        operatorId: admin.operatorId,
        body: { ...body, operatorId: admin.operatorId },
      }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        status: t.String({ minLength: 1, maxLength: 16 }),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .patch(
    '/:id/note',
    ({ admin, params, body }) =>
      forwardUserOperation({
        method: 'PATCH',
        path: `/${encodeURIComponent(params.id)}/note`,
        operatorId: admin.operatorId,
        body: { ...body, operatorId: admin.operatorId },
      }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({ note: t.String({ maxLength: ADMIN_USER_NOTE_MAX_LENGTH }) }),
    },
  )
  .post(
    '/:id/reset-password',
    ({ admin, params, body }) =>
      forwardUserOperation({
        method: 'POST',
        path: `/${encodeURIComponent(params.id)}/reset-password`,
        operatorId: admin.operatorId,
        body: { ...body, operatorId: admin.operatorId },
      }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .post(
    '/:id/revoke-sessions',
    ({ admin, params, body }) =>
      forwardUserOperation({
        method: 'POST',
        path: `/${encodeURIComponent(params.id)}/revoke-sessions`,
        operatorId: admin.operatorId,
        body: { ...body, operatorId: admin.operatorId },
      }),
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
