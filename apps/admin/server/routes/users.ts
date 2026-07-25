import { PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import {
  createUser,
  listUsers,
  resetUserPassword,
  revokeUserSessions,
  setUserStatus,
  UserMutationError,
} from '../lib/users'

function mutationError(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (!(error instanceof UserMutationError)) throw error
  const httpStatus =
    error.code === 'username_taken' ? 409 : error.code === 'user_not_found' ? 404 : 400
  return status(httpStatus, { error: error.code })
}

export const usersRoutes = new Elysia({ prefix: '/api/users' })
  .use(requireAuth)
  .get('/', async () => ({ users: await listUsers() }))
  .post(
    '/',
    async ({ body, status }) => {
      try {
        return status(201, { user: await createUser(body.username, body.password) })
      } catch (error) {
        return mutationError(error, status)
      }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ params, body, status }) => {
      try {
        return { user: await setUserStatus(params.id, body.status) }
      } catch (error) {
        return mutationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({ status: t.String({ minLength: 1, maxLength: 16 }) }),
    },
  )
  .post(
    '/:id/reset-password',
    async ({ params, body, status }) => {
      try {
        await resetUserPassword(params.id, body.password)
        return { ok: true }
      } catch (error) {
        return mutationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .post(
    '/:id/revoke-sessions',
    async ({ params, status }) => {
      try {
        return { ok: true, revoked: await revokeUserSessions(params.id) }
      } catch (error) {
        return mutationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
    },
  )
