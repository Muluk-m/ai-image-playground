import { timingSafeEqual } from 'node:crypto'
import { Elysia, t } from 'elysia'
import { config, getAdminCapabilities } from '../config'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../lib/constants'
import { requireAuth } from '../lib/middleware'
import { createRateLimiter } from '../lib/rate-limit'
import { signSession } from '../lib/session'

const limiter = createRateLimiter({
  maxFailures: 5,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 1024,
})

function clientKey(request: Request): string {
  // Cloudflare tunnel 把客户端 IP 放 CF-Connecting-IP；标准 X-Forwarded-For
  // 取首段；都没就用 'unknown'（测试 / 本机 dev）
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}

function eqPassword(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const authRoutes = new Elysia()
  .post(
    '/api/login',
    ({ body, cookie, request, set }) => {
      const key = clientKey(request)
      if (limiter.isLocked(key)) {
        set.status = 429
        return { error: 'rate_limited' }
      }
      if (!eqPassword(body.password, config.adminPassword)) {
        const locked = limiter.recordFailure(key)
        set.status = locked ? 429 : 401
        return { error: locked ? 'rate_limited' : 'invalid_password' }
      }
      limiter.recordSuccess(key)

      const value = signSession()
      cookie[SESSION_COOKIE_NAME].set({
        value,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      })
      return { ok: true }
    },
    {
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: 256 }),
      }),
    },
  )
  .use(requireAuth)
  .post('/api/logout', ({ cookie }) => {
    cookie[SESSION_COOKIE_NAME].set({
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return { ok: true }
  })
  .get('/api/me', () => ({
    accounts_login: getAdminCapabilities().accountsLogin,
    ok: true as const,
  }))
