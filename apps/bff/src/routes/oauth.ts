import { randomBytes } from 'node:crypto'
import {
  OAUTH_ERROR_QUERY_PARAM,
  OAUTH_LINK_ERROR_QUERY_PARAM,
  OAUTH_LINK_QUERY_PARAM,
  type OAuthProvidersResponse,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  type EnabledOAuthProvider,
  enabledOAuthProviders,
  OAuthExchangeError,
  type OAuthIdentity,
  oauthFetch,
  resolveOAuthProvider,
} from '../lib/oauth'
import {
  linkOAuthIdentity,
  loginWithOAuthIdentity,
  type OAuthLoginOutcome,
  UserOperationError,
  unlinkOAuthIdentity,
} from '../lib/user-admin'
import { resolveAuthUser } from '../lib/user-auth'
import { setUserSessionCookie } from '../lib/user-session'

const STATE_COOKIE = 'image_playground_oauth_state'
const STATE_TTL_SECONDS = 600

const STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth/oauth',
  maxAge: STATE_TTL_SECONDS,
} as const

type CallbackErrorCode =
  | 'access_denied'
  | 'account_disabled'
  | 'exchange_failed'
  | 'identity_failed'
  | 'registration_closed'

type LinkErrorCode =
  | 'access_denied'
  | 'exchange_failed'
  | 'identity_failed'
  | 'identity_taken'
  | 'unauthenticated'

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
  // A wildcard CORS deployment serves the SPA from the BFF itself.
  return (config.corsOriginList[0] ?? bffOrigin(request)).replace(/\/+$/, '')
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

/** Link outcomes land on the workbench, where the login screen that reads auth_error never renders. */
function linkRedirect(request: Request, result: LinkErrorCode | { linked: string }): Response {
  const url = new URL(`${frontendOrigin(request)}/`)
  if (typeof result === 'string') url.searchParams.set(OAUTH_LINK_ERROR_QUERY_PARAM, result)
  else url.searchParams.set(OAUTH_LINK_QUERY_PARAM, result.linked)
  return redirectTo(url.toString())
}

function authorizeRedirect(
  request: Request,
  resolved: EnabledOAuthProvider,
  state: string,
): Response {
  return redirectTo(
    resolved.definition.authorizeUrl({
      credentials: resolved.credentials,
      redirectUri: redirectUri(request, resolved.definition.id),
      state,
      scope: resolved.scope,
    }),
  )
}

type ParsedState =
  | { readonly mode: 'login'; readonly state: string }
  | { readonly mode: 'link'; readonly userId: string; readonly state: string }

/**
 * Provider, mode, and the linking account are bound into the cookie, so no state can be
 * replayed as another provider, as the other mode, or against another account.
 */
function parseState(issued: unknown, providerId: string): ParsedState | null {
  if (typeof issued !== 'string') return null
  const loginPrefix = `${providerId}:login:`
  if (issued.startsWith(loginPrefix)) {
    return { mode: 'login', state: issued.slice(loginPrefix.length) }
  }
  const linkPrefix = `${providerId}:link:`
  if (!issued.startsWith(linkPrefix)) return null
  const rest = issued.slice(linkPrefix.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  return { mode: 'link', userId: rest.slice(0, separator), state: rest.slice(separator + 1) }
}

export const oauthRoutes = new Elysia()
  .use(resolveAuthUser)
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
        value: `${resolved.definition.id}:login:${state}`,
      })
      return authorizeRedirect(request, resolved, state)
    },
    { params: t.Object({ provider: t.String() }) },
  )
  .get(
    '/api/auth/oauth/:provider/link',
    ({ authUser, cookie, params, request, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      if (!authUser) return status(401, { error: 'unauthorized' })
      const resolved = resolveOAuthProvider(params.provider)
      if (!resolved) return status(404, { error: 'provider_unavailable' })

      const state = randomBytes(32).toString('base64url')
      cookie[STATE_COOKIE].set({
        ...STATE_COOKIE_OPTIONS,
        value: `${resolved.definition.id}:link:${authUser.id}:${state}`,
      })
      return authorizeRedirect(request, resolved, state)
    },
    { params: t.Object({ provider: t.String() }) },
  )
  .delete(
    '/api/auth/oauth/:provider/link',
    async ({ authUser, params, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      if (!authUser) return status(401, { error: 'unauthorized' })

      const outcome = await unlinkOAuthIdentity(authUser.id, params.provider)
      if (outcome === 'not_linked') return status(404, { error: 'not_linked' })
      if (outcome === 'last_login_method') return status(409, { error: 'last_login_method' })
      return { ok: true }
    },
    { params: t.Object({ provider: t.String() }) },
  )
  .get(
    '/api/auth/oauth/:provider/callback',
    async ({ authUser, cookie, params, query, request, status }) => {
      if (!isCapabilityEnabled('accounts:login')) return capabilityUnavailable('accounts:login')
      const resolved = resolveOAuthProvider(params.provider)
      if (!resolved) return status(404, { error: 'provider_unavailable' })

      const issued = parseState(cookie[STATE_COOKIE]?.value, resolved.definition.id)
      cookie[STATE_COOKIE].set({ ...STATE_COOKIE_OPTIONS, value: '', maxAge: 0 })
      // A state mismatch is forgery rather than a user-visible failure, so it never redirects.
      if (!issued?.state || query.state !== issued.state) {
        return status(403, { error: 'state_mismatch' })
      }

      let linkingUserId: string | null = null
      if (issued.mode === 'link') {
        // 绑定只能落在发起它的那个账号上；中途换号登录不算。
        if (authUser?.id !== issued.userId) return linkRedirect(request, 'unauthenticated')
        linkingUserId = issued.userId
      }

      if (query.error || !query.code) {
        return linkingUserId
          ? linkRedirect(request, 'access_denied')
          : failureRedirect(request, 'access_denied')
      }

      let identity: OAuthIdentity
      try {
        identity = await resolved.definition.resolveIdentity({
          credentials: resolved.credentials,
          code: query.code,
          redirectUri: redirectUri(request, resolved.definition.id),
          fetchImpl: oauthFetch(),
        })
      } catch (error) {
        const code = error instanceof OAuthExchangeError ? error.code : 'exchange_failed'
        return linkingUserId ? linkRedirect(request, code) : failureRedirect(request, code)
      }

      const claim = {
        provider: resolved.definition.id,
        subject: identity.subject,
        email: identity.email,
        displayName: identity.displayName,
      }

      if (linkingUserId) {
        const outcome = await linkOAuthIdentity(linkingUserId, claim)
        return linkRedirect(
          request,
          outcome === 'identity_taken' ? 'identity_taken' : { linked: resolved.definition.id },
        )
      }

      let result: OAuthLoginOutcome
      try {
        result = await loginWithOAuthIdentity(claim, {
          allowRegistration: isCapabilityEnabled('accounts:self-register'),
        })
      } catch (error) {
        if (error instanceof UserOperationError && error.code === 'account_disabled') {
          return failureRedirect(request, 'account_disabled')
        }
        throw error
      }
      if ('registrationClosed' in result) {
        return failureRedirect(request, 'registration_closed')
      }

      setUserSessionCookie(cookie, result.sessionToken)
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
