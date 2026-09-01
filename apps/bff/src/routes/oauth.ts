import { randomBytes } from 'node:crypto'
import { OAUTH_ERROR_QUERY_PARAM, type OAuthProvidersResponse } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  enabledOAuthProviders,
  OAuthExchangeError,
  oauthFetch,
  resolveOAuthProvider,
} from '../lib/oauth'
import { loginWithOAuthIdentity, UserOperationError } from '../lib/user-admin'
import { USER_SESSION_COOKIE, USER_SESSION_TTL_MS } from '../lib/user-session'

const STATE_COOKIE = 'image_playground_oauth_state'
const STATE_TTL_SECONDS = 600

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/oauth',
  maxAge: STATE_TTL_SECONDS,
} as const

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: USER_SESSION_TTL_MS / 1000,
} as const

type CallbackErrorCode =
  | 'access_denied'
  | 'account_disabled'
  | 'exchange_failed'
  | 'identity_failed'
  | 'registration_closed'

/** Origin the provider redirects back to. Proxy headers only matter when the env is unset. */
function bffOrigin(request: Request): string {
  if (config.auth.publicOrigin) return config.auth.publicOrigin
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '')
    .split(',')[0]
    ?.trim()
  if (!host) return new URL(request.url).origin
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  return `${proto || new URL(request.url).protocol.replace(':', '')}://${host}`
}

function frontendOrigin(request: Request): string {
  if (config.auth.frontendOrigin) return config.auth.frontendOrigin
  const first = config.corsOrigins
    .split(',')
    .map((origin) => origin.trim())
    .find((origin) => origin && origin !== '*')
  // A wildcard CORS deployment serves the SPA from the BFF itself.
  return (first ?? bffOrigin(request)).replace(/\/+$/, '')
}

function redirectUri(request: Request, provider: string): string {
  return `${bffOrigin(request)}/api/auth/oauth/${provider}/callback`
}

function redirectTo(target: string): Response {
  return new Response(null, { status: 302, headers: { location: target } })
}

function failureRedirect(request: Request, code: CallbackErrorCode): Response {
  const url = new URL(`${frontendOrigin(request)}/`)
  url.searchParams.set(OAUTH_ERROR_QUERY_PARAM, code)
  return redirectTo(url.toString())
}

export const oauthRoutes = new Elysia()
  .get('/api/auth/oauth/providers', ({ status }) => {
    if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
    return status(200, { providers: enabledOAuthProviders() } satisfies OAuthProvidersResponse)
  })
  .get(
    '/api/auth/oauth/:provider/start',
    ({ cookie, params, request, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      const resolved = resolveOAuthProvider(params.provider)
      if (!resolved) return status(404, { error: 'provider_unavailable' })

      const state = randomBytes(32).toString('base64url')
      cookie[STATE_COOKIE].set({
        ...STATE_COOKIE_OPTIONS,
        // The provider is bound into the cookie so a state issued for one provider
        // cannot be replayed against another.
        value: `${resolved.definition.id}:${state}`,
      })
      return redirectTo(
        resolved.definition.authorizeUrl({
          credentials: resolved.credentials,
          redirectUri: redirectUri(request, resolved.definition.id),
          state,
        }),
      )
    },
    { params: t.Object({ provider: t.String() }) },
  )
  .get(
    '/api/auth/oauth/:provider/callback',
    async ({ cookie, params, query, request, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      const resolved = resolveOAuthProvider(params.provider)
      if (!resolved) return status(404, { error: 'provider_unavailable' })

      const issued = cookie[STATE_COOKIE]?.value
      cookie[STATE_COOKIE].set({ ...STATE_COOKIE_OPTIONS, value: '', maxAge: 0 })
      const expected =
        typeof issued === 'string' && issued.startsWith(`${resolved.definition.id}:`)
          ? issued.slice(resolved.definition.id.length + 1)
          : ''
      // A state mismatch is forgery rather than a user-visible failure, so it never redirects.
      if (!expected || !query.state || query.state !== expected) {
        return status(403, { error: 'state_mismatch' })
      }
      if (query.error || !query.code) {
        return failureRedirect(request, 'access_denied')
      }

      let identity: Awaited<ReturnType<typeof resolved.definition.resolveIdentity>>
      try {
        identity = await resolved.definition.resolveIdentity({
          credentials: resolved.credentials,
          code: query.code,
          redirectUri: redirectUri(request, resolved.definition.id),
          fetchImpl: oauthFetch(),
        })
      } catch (error) {
        const code = error instanceof OAuthExchangeError ? error.code : 'exchange_failed'
        return failureRedirect(request, code)
      }

      let result: Awaited<ReturnType<typeof loginWithOAuthIdentity>>
      try {
        result = await loginWithOAuthIdentity(
          {
            provider: resolved.definition.id,
            subject: identity.subject,
            email: identity.email,
            displayName: identity.displayName,
          },
          { allowRegistration: isCapabilityEnabled('accounts:self-register') },
        )
      } catch (error) {
        if (error instanceof UserOperationError && error.code === 'account_disabled') {
          return failureRedirect(request, 'account_disabled')
        }
        throw error
      }
      if ('registrationClosed' in result) {
        return failureRedirect(request, 'registration_closed')
      }

      cookie[USER_SESSION_COOKIE].set({
        ...SESSION_COOKIE_OPTIONS,
        value: result.sessionToken,
      })
      return redirectTo(`${frontendOrigin(request)}/`)
    },
    {
      params: t.Object({ provider: t.String() }),
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  )
