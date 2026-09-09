import { signPayload, verifyPayload } from '@image-playground/node-kit'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import {
  createPkceChallenge,
  googleAuthorizeUrl,
  isAllowedAdminEmail,
  resolveGoogleEmail,
} from '../lib/google-oauth'
import { clientKey, loginLimiter } from '../lib/login-rate-limit'
import { setSessionCookie } from '../lib/session'

const STATE_COOKIE_NAME = 'admin_oauth_state'
const STATE_TTL_MS = 10 * 60_000

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/google',
  maxAge: STATE_TTL_MS / 1000,
} as const

interface FlowState {
  readonly state: string
  readonly verifier: string
  readonly redirect: string
}

/** Only same-site paths; `//host` would leave the console entirely. */
function sanitizeRedirect(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/'
}

/** Must match the redirect URI registered on the Google client byte for byte. */
function callbackUri(request: Request): string {
  return `${config.publicOrigin || new URL(request.url).origin}/api/auth/google/callback`
}

function redirectTo(target: string): Response {
  return new Response(null, { status: 302, headers: { location: target } })
}

function loginFailure(code: 'not_allowed' | 'oauth_failed'): Response {
  return redirectTo(`/login?error=${code}`)
}

function readFlowState(raw: unknown): FlowState | null {
  if (typeof raw !== 'string' || !raw) return null
  const payload = verifyPayload(config.cookieSecret, raw)
  if (!payload) return null
  const { state, verifier, redirect } = payload
  if (typeof state !== 'string' || typeof verifier !== 'string' || !state || !verifier) return null
  return { state, verifier, redirect: sanitizeRedirect(redirect) }
}

function logOutcome(outcome: string): void {
  console.info(`admin.login method=google outcome=${outcome}`)
}

export const googleAuthRoutes = new Elysia()
  .get(
    '/api/auth/google',
    ({ cookie, query, request, status }) => {
      if (!config.google.enabled) return status(404, { error: 'google_login_disabled' })

      const { state, verifier, challenge } = createPkceChallenge()
      cookie[STATE_COOKIE_NAME].set({
        ...STATE_COOKIE_OPTIONS,
        value: signPayload(
          config.cookieSecret,
          { state, verifier, redirect: sanitizeRedirect(query.redirect) },
          { ttlMs: STATE_TTL_MS },
        ),
      })
      return redirectTo(googleAuthorizeUrl({ redirectUri: callbackUri(request), state, challenge }))
    },
    { query: t.Object({ redirect: t.Optional(t.String()) }) },
  )
  .get(
    '/api/auth/google/callback',
    async ({ cookie, query, request, status }) => {
      if (!config.google.enabled) return status(404, { error: 'google_login_disabled' })

      const key = clientKey(request)
      if (loginLimiter.isLocked(key)) {
        logOutcome('rate_limited')
        return status(429, { error: 'rate_limited' })
      }

      const issued = readFlowState(cookie[STATE_COOKIE_NAME]?.value)
      cookie[STATE_COOKIE_NAME].set({ ...STATE_COOKIE_OPTIONS, value: '', maxAge: 0 })
      if (!issued || !query.state || query.state !== issued.state || !query.code) {
        loginLimiter.recordFailure(key)
        logOutcome('oauth_failed')
        return loginFailure('oauth_failed')
      }

      const identity = await resolveGoogleEmail({
        code: query.code,
        redirectUri: callbackUri(request),
        verifier: issued.verifier,
      })
      if (!identity.ok || !isAllowedAdminEmail(identity.email)) {
        loginLimiter.recordFailure(key)
        const outcome = identity.ok ? 'not_allowed' : identity.reason
        logOutcome(outcome)
        return loginFailure(outcome)
      }

      loginLimiter.recordSuccess(key)
      setSessionCookie(cookie)
      logOutcome('ok')
      return redirectTo(issued.redirect)
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  )
