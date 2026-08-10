import {
  isValidUsername,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { createRateLimiter } from '../lib/rate-limit'
import { resolveAuthUser } from '../lib/user-auth'
import {
  createUserSession,
  revokeUserSession,
  USER_SESSION_COOKIE,
  USER_SESSION_TTL_MS,
} from '../lib/user-session'

// 固定的无效账号 hash 仅用于等时校验，不是凭证或 secret。
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$TTNDEQYYmWpQHJyMtmCCcw3/ju3Jwww0SB/ACmMN53U$9VqGN+Ud4kjOI2bzudleozWu49uFGhNeWn3lZCfSAdc'

const sourceLimiter = createRateLimiter({
  maxFailures: 5,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 2048,
})

// 来源 header 可能在未锁定反代入口时被伪造；账号维度的第二道限速防止攻击者
// 轮换 IP/header 后继续对同一账号暴力尝试。
const accountLimiter = createRateLimiter({
  maxFailures: 10,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 2048,
})

function clientKey(request: Request): string {
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}

export const userAuthRoutes = new Elysia()
  .use(resolveAuthUser)
  .post(
    '/api/auth/login',
    async ({ body, cookie, request, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')

      const key = clientKey(request)
      const username = normalizeUsername(body.username)
      if (sourceLimiter.isLocked(key) || accountLimiter.isLocked(username)) {
        return status(429, { error: 'rate_limited' })
      }
      const [user] = isValidUsername(username)
        ? await db.select().from(schema.users).where(eq(schema.users.username, username)).limit(1)
        : []

      let passwordMatches = false
      try {
        passwordMatches = await Bun.password.verify(
          body.password,
          user?.password_hash ?? DUMMY_PASSWORD_HASH,
        )
      } catch {
        passwordMatches = false
      }

      if (!user || user.status !== 'active' || !passwordMatches) {
        const sourceLocked = sourceLimiter.recordFailure(key)
        const accountLocked = accountLimiter.recordFailure(username)
        const rateLimited = sourceLocked || accountLocked
        return status(rateLimited ? 429 : 401, {
          error: rateLimited ? 'rate_limited' : 'invalid_credentials',
        })
      }

      const authenticated = await db.transaction(async (tx) => {
        const [current] = await tx
          .select({
            id: schema.users.id,
            password_hash: schema.users.password_hash,
            status: schema.users.status,
            username: schema.users.username,
          })
          .from(schema.users)
          .where(eq(schema.users.id, user.id))
          .for('update')
        if (
          !current ||
          current.status !== 'active' ||
          current.password_hash !== user.password_hash
        ) {
          return null
        }

        const now = Date.now()
        const [activated] = await tx
          .update(schema.users)
          .set({ last_login_at: now, updated_at: now })
          .where(eq(schema.users.id, user.id))
          .returning({ id: schema.users.id, username: schema.users.username })
        if (!activated) return null

        const token = await createUserSession(user.id, tx)
        return { token, user: activated }
      })
      if (!authenticated) {
        sourceLimiter.recordFailure(key)
        accountLimiter.recordFailure(username)
        return status(401, { error: 'invalid_credentials' })
      }

      cookie[USER_SESSION_COOKIE].set({
        value: authenticated.token,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: USER_SESSION_TTL_MS / 1000,
      })
      sourceLimiter.recordSuccess(key)
      accountLimiter.recordSuccess(username)
      return { user: authenticated.user }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .post('/api/auth/logout', async ({ cookie }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    const raw = cookie[USER_SESSION_COOKIE]?.value
    await revokeUserSession(typeof raw === 'string' ? raw : '')
    cookie[USER_SESSION_COOKIE].set({
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return { ok: true }
  })
  .get('/api/auth/me', ({ authUser, status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    if (!authUser) return status(401, { error: 'unauthorized' })
    return { user: authUser }
  })
