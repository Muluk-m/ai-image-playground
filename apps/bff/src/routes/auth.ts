import {
  isValidUsername,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
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

const limiter = createRateLimiter({
  maxFailures: 5,
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
      if (!config.auth.enabled) return status(404, { error: 'auth_disabled' })

      const key = clientKey(request)
      if (limiter.isLocked(key)) return status(429, { error: 'rate_limited' })

      const username = normalizeUsername(body.username)
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
        const locked = limiter.recordFailure(key)
        return status(locked ? 429 : 401, {
          error: locked ? 'rate_limited' : 'invalid_credentials',
        })
      }

      // 密码校验和写 session 之间再确认一次 active，关闭竞态窗口。
      const now = Date.now()
      const activated = await db
        .update(schema.users)
        .set({ last_login_at: now, updated_at: now })
        .where(and(eq(schema.users.id, user.id), eq(schema.users.status, 'active')))
        .returning({ id: schema.users.id, username: schema.users.username })
      if (activated.length === 0) {
        limiter.recordFailure(key)
        return status(401, { error: 'invalid_credentials' })
      }

      const token = await createUserSession(user.id)
      cookie[USER_SESSION_COOKIE].set({
        value: token,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: USER_SESSION_TTL_MS / 1000,
      })
      limiter.recordSuccess(key)
      return { user: activated[0]! }
    },
    {
      body: t.Object({
        username: t.String({ minLength: 1, maxLength: USERNAME_MAX_LENGTH }),
        password: t.String({ minLength: 1, maxLength: PASSWORD_MAX_LENGTH }),
      }),
    },
  )
  .post('/api/auth/logout', async ({ cookie }) => {
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
    if (!config.auth.enabled) return { auth_enabled: false as const, user: null }
    if (!authUser) return status(401, { error: 'unauthorized' })
    return { auth_enabled: true as const, user: authUser }
  })
