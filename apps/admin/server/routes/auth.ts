import { timingSafeEqual } from 'node:crypto'
import { Elysia, t } from 'elysia'
import { config, getAdminCapabilities } from '../config'
import { clientKey, loginLimiter } from '../lib/login-rate-limit'
import { requireAuth } from '../lib/middleware'
import { clearSessionCookie, setSessionCookie } from '../lib/session'

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
      if (config.google.enabled) {
        set.status = 403
        return { error: 'password_login_disabled' }
      }
      const key = clientKey(request)
      if (loginLimiter.isLocked(key)) {
        set.status = 429
        return { error: 'rate_limited' }
      }
      if (!eqPassword(body.password, config.adminPassword)) {
        const locked = loginLimiter.recordFailure(key)
        set.status = locked ? 429 : 401
        return { error: locked ? 'rate_limited' : 'invalid_password' }
      }
      loginLimiter.recordSuccess(key)
      setSessionCookie(cookie)
      return { ok: true }
    },
    {
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: 256 }),
      }),
    },
  )
  // Public: the login page has no session yet and must know which button to render.
  .get('/api/auth/methods', () => ({
    google_login: config.google.enabled,
    password_login: !config.google.enabled,
  }))
  .use(requireAuth)
  .post('/api/logout', ({ cookie }) => {
    clearSessionCookie(cookie)
    return { ok: true }
  })
  .get('/api/me', () => ({
    accounts_login: getAdminCapabilities().accountsLogin,
    accounts_sync: getAdminCapabilities().accountsSync,
    ok: true as const,
  }))
