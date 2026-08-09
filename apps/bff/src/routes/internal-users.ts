import { PASSWORD_MAX_LENGTH, USERNAME_MAX_LENGTH } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  createUser,
  resetUserPassword,
  revokeUserSessions,
  setUserStatus,
  UserOperationError,
} from '../lib/user-admin'
import { requireInternalService } from '../lib/user-auth'

function operationError(error: unknown, status: (code: number, body: unknown) => unknown) {
  if (!(error instanceof UserOperationError)) throw error
  const httpStatus =
    error.code === 'username_taken' ? 409 : error.code === 'user_not_found' ? 404 : 400
  return status(httpStatus, { error: error.code })
}

export const internalUserRoutes = new Elysia({ prefix: '/internal/admin/users' })
  .use(requireInternalService)
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
  })
  .post(
    '/',
    async ({ body, status }) => {
      try {
        return status(201, { user: await createUser(body.username, body.password) })
      } catch (error) {
        return operationError(error, status)
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
        return operationError(error, status)
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
        return operationError(error, status)
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
        return operationError(error, status)
      }
    },
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
