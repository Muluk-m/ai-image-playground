import { PASSWORD_MAX_LENGTH } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import {
  AccountProfileError,
  deleteOwnAccount,
  getAccountProfile,
  readAccountAvatar,
  readAvatarUpload,
  saveAccountAvatar,
  updateAccountProfile,
} from '../lib/account-profile'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { createRateLimiter, createWindowLimiter } from '../lib/rate-limit'
import { resolveAuthUser } from '../lib/user-auth'
import {
  clearUserSessionCookie,
  listAccountSessions,
  revokeOtherSessions,
  USER_SESSION_COOKIE,
} from '../lib/user-session'

const avatarLimiter = createWindowLimiter(60 * 60_000, 2048)
const deleteLimiter = createRateLimiter({
  maxFailures: 10,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 2048,
})

function accountError(error: unknown): { status: number; error: string } | null {
  if (!(error instanceof AccountProfileError)) return null
  return { status: error.status, error: error.code }
}

export const accountRoutes = new Elysia()
  .use(resolveAuthUser)
  .get(
    '/api/avatars/:userId',
    async ({ params, status }) => {
      const bytes = await readAccountAvatar(params.userId)
      if (!bytes) return status(404, { error: 'not_found' })
      return new Response(bytes, {
        headers: {
          'content-type': 'image/webp',
          'cache-control': 'public, max-age=86400',
        },
      })
    },
    { params: t.Object({ userId: t.String({ minLength: 1, maxLength: 64 }) }) },
  )
  .get('/api/me/profile', async ({ authUser, status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    if (!authUser) return status(401, { error: 'unauthorized' })
    return getAccountProfile(authUser.id)
  })
  .patch(
    '/api/me/profile',
    async ({ authUser, body, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        return await updateAccountProfile(authUser.id, body)
      } catch (error) {
        const rejected = accountError(error)
        if (rejected) return status(rejected.status, { error: rejected.error })
        throw error
      }
    },
    {
      body: t.Object({
        nickname: t.Optional(t.Union([t.String({ maxLength: 80 }), t.Null()])),
        bio: t.Optional(t.Union([t.String({ maxLength: 400 }), t.Null()])),
      }),
    },
  )
  .post('/api/me/avatar', async ({ authUser, request, status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    if (!authUser) return status(401, { error: 'unauthorized' })
    if (avatarLimiter.over(authUser.id, 30)) return status(429, { error: 'rate_limited' })
    try {
      const upload = await readAvatarUpload(request)
      return await saveAccountAvatar(authUser.id, upload.bytes, upload.declaredType)
    } catch (error) {
      const rejected = accountError(error)
      if (rejected) return status(rejected.status, { error: rejected.error })
      throw error
    }
  })
  .get('/api/me/sessions', async ({ authUser, cookie, status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    if (!authUser) return status(401, { error: 'unauthorized' })
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const sessions = await listAccountSessions(authUser.id, typeof raw === 'string' ? raw : '')
    return { sessions }
  })
  .post('/api/me/sessions/revoke-others', async ({ authUser, cookie, status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    if (!authUser) return status(401, { error: 'unauthorized' })
    const raw = cookie[USER_SESSION_COOKIE]?.value
    const revoked = await revokeOtherSessions(authUser.id, typeof raw === 'string' ? raw : '')
    return { revoked }
  })
  .delete(
    '/api/me',
    async ({ authUser, body, cookie, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (deleteLimiter.isLocked(authUser.id)) return status(429, { error: 'rate_limited' })
      try {
        await deleteOwnAccount(authUser.id, body?.password)
      } catch (error) {
        const rejected = accountError(error)
        if (rejected) {
          if (
            rejected.error === 'invalid_credentials' &&
            deleteLimiter.recordFailure(authUser.id)
          ) {
            return status(429, { error: 'rate_limited' })
          }
          return status(rejected.status, { error: rejected.error })
        }
        throw error
      }
      deleteLimiter.recordSuccess(authUser.id)
      clearUserSessionCookie(cookie)
      return { ok: true }
    },
    {
      body: t.Optional(
        t.Object({
          password: t.Optional(t.String({ maxLength: PASSWORD_MAX_LENGTH })),
        }),
      ),
    },
  )
