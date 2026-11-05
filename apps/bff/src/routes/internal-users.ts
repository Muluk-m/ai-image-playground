import {
  ADMIN_USER_NOTE_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  createUser,
  resetUserPassword,
  revokeUserSessions,
  setAdminUserNote,
  setUserStatus,
  UserOperationError,
} from '../lib/user-admin'
import { requireInternalService } from '../lib/user-auth'

function actorFrom(
  request: Request,
  body: { operatorId?: string; reason?: string },
): { operatorId?: string; reason?: string } {
  const header = request.headers.get('x-admin-operator')?.trim()
  const operatorId = header || body.operatorId?.trim() || undefined
  const reason = body.reason?.trim() || undefined
  return {
    ...(operatorId ? { operatorId } : {}),
    ...(reason ? { reason } : {}),
  }
}

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
    async ({ body, request, status }) => {
      try {
        return status(201, {
          user: await createUser(body.username, body.password, actorFrom(request, body)),
        })
      } catch (error) {
        return operationError(error, status)
      }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ params, body, request, status }) => {
      try {
        return { user: await setUserStatus(params.id, body.status, actorFrom(request, body)) }
      } catch (error) {
        return operationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        status: t.String({ minLength: 1, maxLength: 16 }),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .patch(
    '/:id/note',
    async ({ params, body, request, status }) => {
      try {
        return { note: await setAdminUserNote(params.id, body.note, actorFrom(request, body)) }
      } catch (error) {
        return operationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        note: t.String({ maxLength: ADMIN_USER_NOTE_MAX_LENGTH }),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .post(
    '/:id/reset-password',
    async ({ params, body, request, status }) => {
      try {
        await resetUserPassword(params.id, body.password, actorFrom(request, body))
        return { ok: true }
      } catch (error) {
        return operationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
        operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
        reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
      }),
    },
  )
  .post(
    '/:id/revoke-sessions',
    async ({ params, body, request, status }) => {
      try {
        return {
          ok: true,
          revoked: await revokeUserSessions(params.id, actorFrom(request, body ?? {})),
        }
      } catch (error) {
        return operationError(error, status)
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Optional(
        t.Object({
          operatorId: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
          reason: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
        }),
      ),
    },
  )
