import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEFAULT_AVATAR_PATH } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
  type PrivateBffOverlay,
  type PrivateTaskHooks,
} from '../../lib/private-overlay'

const TEST_DB = await resetTestDatabase('bff_oauth')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com,https://other.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../authenticated-operator-config.json')
process.env.AUTH_PUBLIC_ORIGIN = 'https://api.example.com'

const { config } = await import('../../config')
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { registerOAuthProviders, setOAuthFetchForTesting } = await import('../../lib/oauth')
const { USER_SESSION_COOKIE } = await import('../../lib/user-session')

const PRIVATE_PROVIDER_ID = 'starlight'
const PRIVATE_CLIENT_ID_ENV = 'OAUTH_STARLIGHT_CLIENT_ID'
const PRIVATE_CLIENT_SECRET_ENV = 'OAUTH_STARLIGHT_CLIENT_SECRET'
registerOAuthProviders([
  {
    id: PRIVATE_PROVIDER_ID,
    label: 'Starlight',
    credentialEnv: { clientId: PRIVATE_CLIENT_ID_ENV, clientSecret: PRIVATE_CLIENT_SECRET_ENV },
    defaultScope: 'openid profile email',
    authorizeUrl({ credentials, redirectUri, state, scope }) {
      const url = new URL('https://starlight.example/authorize')
      url.searchParams.set('client_id', credentials.clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('state', state)
      url.searchParams.set('scope', scope)
      return url.toString()
    },
    async resolveIdentity({ code }) {
      return {
        subject: `starlight-${code}`,
        email: `${code}@starlight.example`,
        emailVerified: false,
        displayName: `Starlight ${code}`,
      }
    },
  },
])

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

interface RecordedCall {
  url: string
  body: string | null
  authorization: string | null
}

function stubUpstream(routes: Record<string, () => Response>): RecordedCall[] {
  const calls: RecordedCall[] = []
  setOAuthFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const headers = new Headers(init?.headers)
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: headers.get('authorization'),
    })
    const handler = routes[url]
    if (!handler) throw new Error(`unexpected upstream fetch: ${url}`)
    return handler()
  }) as typeof fetch)
  return calls
}

function googleRoutes(profile: Record<string, unknown>): Record<string, () => Response> {
  return {
    [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ access_token: 'google-grant-alpha' }),
    [GOOGLE_USERINFO_ENDPOINT]: () => Response.json(profile),
  }
}

function readCookie(response: Response, name: string): string | null {
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';')
    const separator = pair?.indexOf('=') ?? -1
    if (pair && separator > 0 && pair.slice(0, separator) === name) {
      return decodeURIComponent(pair.slice(separator + 1))
    }
  }
  return null
}

function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`https://api.example.com${path}`, { headers }))
}

async function startFlow(provider: string): Promise<{ state: string; cookie: string }> {
  const response = await request(`/api/auth/oauth/${provider}/start`)
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '')
  const cookie = readCookie(response, 'image_playground_oauth_state')
  if (!cookie) throw new Error('start did not issue a state cookie')
  return { state: location.searchParams.get('state') ?? '', cookie }
}

function callback(
  provider: string,
  query: Record<string, string>,
  stateCookie?: string,
  returnToCookie?: string,
): Promise<Response> {
  const search = new URLSearchParams(query).toString()
  const cookies = [
    stateCookie ? `image_playground_oauth_state=${encodeURIComponent(stateCookie)}` : '',
    returnToCookie ? `image_playground_oauth_return_to=${encodeURIComponent(returnToCookie)}` : '',
  ].filter(Boolean)
  return request(
    `/api/auth/oauth/${provider}/callback?${search}`,
    cookies.length > 0 ? { cookie: cookies.join('; ') } : {},
  )
}

function enableGoogle(): void {
  process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret-fixture'
}

function enableStarlight(): void {
  process.env.OAUTH_STARLIGHT_CLIENT_ID = 'starlight-client-fixture'
  process.env.OAUTH_STARLIGHT_CLIENT_SECRET = 'starlight-secret-fixture'
}

function disableAllProviders(): void {
  process.env.OAUTH_GOOGLE_CLIENT_ID = ''
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = ''
  process.env.OAUTH_STARLIGHT_CLIENT_ID = ''
  process.env.OAUTH_STARLIGHT_CLIENT_SECRET = ''
}

let createdUserIds: string[]

function trackingOverlay(): PrivateBffOverlay {
  return Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async onUserCreated({ userId }: Parameters<PrivateTaskHooks['onUserCreated']>[0]) {
        createdUserIds.push(userId)
      },
    },
  })
}

beforeEach(async () => {
  delete process.env.AUTH_LOGIN_METHODS_BY_ORIGIN
  createdUserIds = []
  _setPrivateBffOverlayForTesting(trackingOverlay())
  disableAllProviders()
  setOAuthFetchForTesting()
  await db.delete(schema.user_sessions)
  await db.delete(schema.user_identities)
  await db.delete(schema.operator_audits)
  await db.delete(schema.users)
})

afterAll(async () => {
  delete process.env.AUTH_LOGIN_METHODS_BY_ORIGIN
  _setPrivateBffOverlayForTesting()
  setOAuthFetchForTesting()
  await closeDb()
})

describe('oauth provider discovery', () => {
  it('lists nothing while no provider has both secrets', async () => {
    process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
    const response = await request('/api/auth/oauth/providers')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ providers: [], loginMethods: { password: true, registration: true } })
  })

  it('lists every fully configured provider without leaking secrets', async () => {
    enableGoogle()
    const response = await request('/api/auth/oauth/providers')
    const body = (await response.json()) as { providers: unknown[] }
    expect(body.providers).toEqual([{ id: 'google', label: 'Google' }])
    expect(JSON.stringify(body)).not.toContain('secret')
  })
  it('discovers a fully configured private provider', async () => {
    enableStarlight()
    const response = await request('/api/auth/oauth/providers')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      providers: [{ id: 'starlight', label: 'Starlight' }],
      loginMethods: { password: true, registration: true },
    })
  })
})

describe('oauth start', () => {
  it('rejects an unconfigured or unknown provider', async () => {
    expect((await request('/api/auth/oauth/google/start')).status).toBe(404)
    expect((await request('/api/auth/oauth/myspace/start')).status).toBe(404)
  })

  it('redirects to Google with a provider-bound OAuth state', async () => {
    enableGoogle()
    const response = await request('/api/auth/oauth/google/start')
    expect(response.status).toBe(302)

    const location = new URL(response.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(location.searchParams.get('client_id')).toBe('google-client-fixture')
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/auth/oauth/google/callback',
    )
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('scope')).toBe('openid email profile')
  })
  it('returns a completed login to an explicitly supplied allowlisted frontend origin', async () => {
    enableGoogle()
    stubUpstream(
      googleRoutes({
        sub: 'google-explicit-origin',
        email: 'explicit-origin@example.com',
        email_verified: true,
        name: 'Explicit Origin',
      }),
    )
    const response = await request(
      `/api/auth/oauth/google/start?frontend_origin=${encodeURIComponent('https://other.example.com')}`,
    )
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(response, 'image_playground_oauth_state')
    const returnToCookie = readCookie(response, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const callbackResponse = await callback(
      'google',
      { code: 'explicit-origin-code', state },
      stateCookie,
      returnToCookie,
    )
    expect(callbackResponse.headers.get('location')).toBe(
      'https://other.example.com/image?auth_session=1',
    )
  })
})

describe('oauth callback', () => {
  it('rejects an unconfigured provider', async () => {
    expect((await callback('google', { code: 'x', state: 'y' })).status).toBe(404)
  })

  it('rejects a missing, forged, or provider-unbound state', async () => {
    enableGoogle()
    const { state, cookie } = await startFlow('google')

    expect((await callback('google', { code: 'c', state })).status).toBe(403)
    expect((await callback('google', { code: 'c', state: 'forged' }, cookie)).status).toBe(403)
    // The cookie carries `<provider>:<mode>:<state>`; a bare state must not authorize the
    // callback, or a state issued for one provider could be replayed against another.
    expect((await callback('google', { code: 'c', state }, state)).status).toBe(403)
  })

  it('redirects with auth_error when the provider reports a denial', async () => {
    enableGoogle()
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { error: 'access_denied', state }, cookie)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=access_denied&login=1',
    )
  })
  it('logs in through a private provider and returns to a second allowlisted origin on success', async () => {
    enableStarlight()
    const response = await request(
      `/api/auth/oauth/starlight/start?frontend_origin=${encodeURIComponent('https://other.example.com')}&return_to=${encodeURIComponent('/assets?from=starlight')}`,
    )
    expect(response.status).toBe(302)
    const location = new URL(response.headers.get('location') ?? '')
    expect(location.origin).toBe('https://starlight.example')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(response, 'image_playground_oauth_state')
    const returnToCookie = readCookie(response, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const callbackResponse = await callback(
      'starlight',
      { code: 'private-success', state },
      stateCookie,
      returnToCookie,
    )
    expect(callbackResponse.headers.get('location')).toBe(
      'https://other.example.com/assets?from=starlight&auth_session=1',
    )
    expect(readCookie(callbackResponse, USER_SESSION_COOKIE)).toBeTruthy()

    const [identity] = await db
      .select()
      .from(schema.user_identities)
      .where(
        and(
          eq(schema.user_identities.provider, 'starlight'),
          eq(schema.user_identities.subject, 'starlight-private-success'),
        ),
      )
    expect(identity?.email).toBe('private-success@starlight.example')
  })

  it('returns a private provider denial to the second allowlisted origin', async () => {
    enableStarlight()
    const response = await request(
      `/api/auth/oauth/starlight/start?frontend_origin=${encodeURIComponent('https://other.example.com')}&return_to=${encodeURIComponent('/explore')}`,
    )
    const location = new URL(response.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(response, 'image_playground_oauth_state')
    const returnToCookie = readCookie(response, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const callbackResponse = await callback(
      'starlight',
      { error: 'access_denied', state },
      stateCookie,
      returnToCookie,
    )
    expect(callbackResponse.headers.get('location')).toBe(
      'https://other.example.com/explore?auth_error=access_denied&login=1',
    )
  })

  it('rejects a state issued for the private provider when callback uses Google', async () => {
    enableStarlight()
    enableGoogle()
    const start = await request('/api/auth/oauth/starlight/start')
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    if (!stateCookie) throw new Error('start did not issue OAuth state cookie')
    expect((await callback('google', { code: 'cross-provider', state }, stateCookie)).status).toBe(
      403,
    )
  })

  it('returns a successful login to the requested workspace route with query and hash', async () => {
    enableGoogle()
    stubUpstream(
      googleRoutes({
        sub: 'google-return-target',
        email: 'return-target@example.com',
        email_verified: true,
        name: 'Return Target',
      }),
    )
    const start = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/assets?keep=1#x')}`,
    )
    const location = new URL(start.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const response = await callback(
      'google',
      { code: 'code-alpha', state },
      stateCookie,
      returnToCookie,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/assets?keep=1&auth_session=1#x',
    )
  })

  it('returns a denial to the requested workspace route and opens login', async () => {
    enableGoogle()
    const start = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/assets?keep=1#x')}`,
    )
    const location = new URL(start.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const response = await callback(
      'google',
      { error: 'access_denied', state },
      stateCookie,
      returnToCookie,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/assets?keep=1&auth_error=access_denied&login=1#x',
    )
  })

  it('returns a denial to a toolbox tool address', async () => {
    enableGoogle()
    const start = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/tools/resize')}`,
    )
    const location = new URL(start.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const response = await callback(
      'google',
      { error: 'access_denied', state },
      stateCookie,
      returnToCookie,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/tools/resize?auth_error=access_denied&login=1',
    )
  })

  it('returns to the CLI device confirmation page with its user code', async () => {
    enableGoogle()
    const start = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/device?user_code=BCDF-GHJK')}`,
    )
    const location = new URL(start.headers.get('location') ?? '')
    const state = location.searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state')
    const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
    if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')

    const response = await callback(
      'google',
      { error: 'access_denied', state },
      stateCookie,
      returnToCookie,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/device?user_code=BCDF-GHJK&auth_error=access_denied&login=1',
    )
  })

  it('defaults malicious return targets and mismatched metadata to the image workspace', async () => {
    enableGoogle()
    for (const requested of ['https://evil.example/steal', '//evil.example/steal', '/']) {
      const start = await request(
        `/api/auth/oauth/google/start?return_to=${encodeURIComponent(requested)}`,
      )
      const location = new URL(start.headers.get('location') ?? '')
      const state = location.searchParams.get('state') ?? ''
      const stateCookie = readCookie(start, 'image_playground_oauth_state')
      const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
      if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')
      const response = await callback(
        'google',
        { error: 'access_denied', state },
        stateCookie,
        returnToCookie,
      )
      expect(response.headers.get('location')).toBe(
        'https://app.example.com/image?auth_error=access_denied&login=1',
      )
    }

    const first = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/assets')}`,
    )
    const firstMetadata = readCookie(first, 'image_playground_oauth_return_to')
    const second = await request(
      `/api/auth/oauth/google/start?return_to=${encodeURIComponent('/explore')}`,
    )
    const secondLocation = new URL(second.headers.get('location') ?? '')
    const secondStateCookie = readCookie(second, 'image_playground_oauth_state')
    if (!firstMetadata || !secondStateCookie) throw new Error('start did not issue OAuth cookies')
    const response = await callback(
      'google',
      { error: 'access_denied', state: secondLocation.searchParams.get('state') ?? '' },
      secondStateCookie,
      firstMetadata,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=access_denied&login=1',
    )
  })

  it('redirects with auth_error when the token exchange fails', async () => {
    enableGoogle()
    stubUpstream({
      [GOOGLE_TOKEN_ENDPOINT]: () => new Response('nope', { status: 400 }),
    })
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { code: 'bad-code', state }, cookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=exchange_failed&login=1',
    )
  })

  it('redirects with auth_error when the token response carries no grant', async () => {
    enableGoogle()
    stubUpstream({
      [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ error: 'invalid_grant' }),
    })
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { code: 'stale', state }, cookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=exchange_failed&login=1',
    )
  })

  it('redirects with auth_error when the profile carries no subject', async () => {
    enableGoogle()
    stubUpstream(googleRoutes({ email: 'nobody@example.com', email_verified: true }))
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { code: 'code-alpha', state }, cookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=identity_failed&login=1',
    )
  })

  it('redirects with auth_error when the profile request fails', async () => {
    enableGoogle()
    stubUpstream({
      [GOOGLE_TOKEN_ENDPOINT]: () => Response.json({ access_token: 'google-grant-alpha' }),
      [GOOGLE_USERINFO_ENDPOINT]: () => new Response('nope', { status: 500 }),
    })
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { code: 'code-alpha', state }, cookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=identity_failed&login=1',
    )
  })

  it('provisions a user, an identity, and the registration hook on first login', async () => {
    enableGoogle()
    const calls = stubUpstream(
      googleRoutes({
        sub: 'google-subject-1',
        email: 'Creator@Example.com',
        email_verified: true,
        name: 'Creator',
      }),
    )
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { code: 'code-alpha', state }, cookie)

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://app.example.com/image?auth_session=1')

    const exchange = new URLSearchParams(calls[0]?.body ?? '')
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-alpha')
    expect(exchange.get('client_secret')).toBe('google-secret-fixture')
    expect(exchange.get('redirect_uri')).toBe(
      'https://api.example.com/api/auth/oauth/google/callback',
    )
    expect(calls[1]?.authorization).toBe('Bearer google-grant-alpha')

    const [identity] = await db
      .select()
      .from(schema.user_identities)
      .where(
        and(
          eq(schema.user_identities.provider, 'google'),
          eq(schema.user_identities.subject, 'google-subject-1'),
        ),
      )
    expect(identity?.email).toBe('creator@example.com')
    expect(identity?.display_name).toBe('Creator')

    const [user] = await db.select().from(schema.users)
    expect(user?.username).toBe('creator@example.com')
    expect(user?.email_verified_at).not.toBeNull()
    expect(user?.id).toBe(identity?.user_id ?? '')
    expect(createdUserIds).toEqual([user?.id ?? ''])

    const sessionToken = readCookie(response, USER_SESSION_COOKIE)
    expect(sessionToken).toBeTruthy()
    const me = await request('/api/auth/me', {
      cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
    })
    expect(await me.json()).toEqual({
      user: {
        id: user?.id,
        username: 'creator@example.com',
        nickname: 'Creator',
        bio: null,
        avatar_url: DEFAULT_AVATAR_PATH,
        avatar_is_default: true,
      },
    })
  })

  it('reuses the account on a second login for the same subject', async () => {
    enableGoogle()
    const profile = {
      sub: 'google-subject-1',
      email: 'creator@example.com',
      email_verified: true,
      name: 'Creator',
    }
    stubUpstream(googleRoutes(profile))
    const first = await startFlow('google')
    await callback('google', { code: 'code-alpha', state: first.state }, first.cookie)

    stubUpstream(googleRoutes(profile))
    const second = await startFlow('google')
    const response = await callback(
      'google',
      { code: 'code-beta', state: second.state },
      second.cookie,
    )

    expect(response.headers.get('location')).toBe('https://app.example.com/image?auth_session=1')
    expect(await db.select().from(schema.users)).toHaveLength(1)
    expect(await db.select().from(schema.user_identities)).toHaveLength(1)
    expect(createdUserIds).toHaveLength(1)
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeTruthy()
  })

  it('refreshes metadata and seeds a null nickname without changing account ownership', async () => {
    enableGoogle()
    stubUpstream(googleRoutes({ sub: 'stable-subject', email: 'old@example.com', email_verified: true }))
    const first = await startFlow('google')
    await callback('google', { code: 'first', state: first.state }, first.cookie)
    const [original] = await db.select().from(schema.users)
    expect(original?.nickname).toBeNull()

    stubUpstream(googleRoutes({ sub: 'stable-subject', email: 'New@Example.com', email_verified: true, name: '  新昵称  ' }))
    const second = await startFlow('google')
    await callback('google', { code: 'second', state: second.state }, second.cookie)
    const [updated] = await db.select().from(schema.users)
    const [identity] = await db.select().from(schema.user_identities)
    expect(updated?.id).toBe(original?.id)
    expect(updated?.username).toBe('old@example.com')
    expect(updated?.nickname).toBe('新昵称')
    expect(identity?.email).toBe('new@example.com')
    expect(identity?.display_name).toBe('新昵称')

    await db.update(schema.users).set({ nickname: 'My manual name' }).where(eq(schema.users.id, updated!.id))
    stubUpstream(googleRoutes({ sub: 'stable-subject', name: 'Changed upstream' }))
    const third = await startFlow('google')
    await callback('google', { code: 'third', state: third.state }, third.cookie)
    const [preserved] = await db.select().from(schema.users)
    const [refreshed] = await db.select().from(schema.user_identities)
    expect(preserved?.nickname).toBe('My manual name')
    expect(preserved?.username).toBe('old@example.com')
    expect(refreshed?.email).toBeNull()
    expect(refreshed?.display_name).toBe('Changed upstream')
    expect(createdUserIds).toHaveLength(1)
  })

  it('stores an unverified private-provider email without claiming or merging its password account', async () => {
    enableStarlight()
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'password-owner', username: 'contact@starlight.example', password_hash: 'fixture-hash',
      status: 'active', created_at: now, updated_at: now,
    })
    const flow = await startFlow(PRIVATE_PROVIDER_ID)
    const response = await callback(PRIVATE_PROVIDER_ID, { code: 'contact', state: flow.state }, flow.cookie)
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeTruthy()
    const [identity] = await db.select().from(schema.user_identities)
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, identity!.user_id))
    expect(identity?.email).toBe('contact@starlight.example')
    expect(user?.id).not.toBe('password-owner')
    expect(user?.username).not.toContain('@')
    expect(user?.email_verified_at).toBeNull()
    expect(user?.nickname).toBe('Starlight contact')
    expect(await db.select().from(schema.users)).toHaveLength(2)
  })

  it('truncates display names by Unicode code points and leaves too-short nicknames unset', async () => {
    enableGoogle()
    stubUpstream(googleRoutes({ sub: 'long-name', name: '😀'.repeat(21) }))
    const first = await startFlow('google')
    await callback('google', { code: 'long', state: first.state }, first.cookie)
    const [user] = await db.select().from(schema.users)
    expect(user?.nickname).toBe('😀'.repeat(20))
    stubUpstream(googleRoutes({ sub: 'short-name', name: '一' }))
    const second = await startFlow('google')
    await callback('google', { code: 'short', state: second.state }, second.cookie)
    const [identity] = await db.select().from(schema.user_identities).where(eq(schema.user_identities.subject, 'short-name'))
    const [shortUser] = await db.select().from(schema.users).where(eq(schema.users.id, identity!.user_id))
    expect(shortUser?.nickname).toBeNull()
  })

  it('derives a handle from the subject when the address is unverified', async () => {
    enableGoogle()
    stubUpstream(
      googleRoutes({
        sub: 'google-subject-2',
        email: 'unverified@example.com',
        email_verified: false,
      }),
    )
    const { state, cookie } = await startFlow('google')
    await callback('google', { code: 'code-alpha', state }, cookie)

    const [user] = await db.select().from(schema.users)
    expect(user?.username).toBe('google-google-subject-2')
    const [identity] = await db.select().from(schema.user_identities)
    expect(identity?.email).toBeNull()
  })

  it('suffixes the handle when the generated one is taken', async () => {
    enableGoogle()
    const now = Date.now()
    await db.insert(schema.users).values({
      id: 'existing-user',
      username: 'creator@example.com',
      password_hash: 'fixture-hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
    stubUpstream(
      googleRoutes({ sub: 'google-subject-3', email: 'creator@example.com', email_verified: true }),
    )
    const { state, cookie } = await startFlow('google')
    await callback('google', { code: 'code-alpha', state }, cookie)

    const [identity] = await db.select().from(schema.user_identities)
    const [created] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, identity?.user_id ?? ''))
    expect(created?.username).toBe('creator')
    expect(created?.id).not.toBe('existing-user')
  })

  it('refuses a disabled account without issuing a session', async () => {
    enableGoogle()
    stubUpstream(
      googleRoutes({ sub: 'google-subject-4', email: 'blocked@example.com', email_verified: true }),
    )
    const first = await startFlow('google')
    await callback('google', { code: 'code-alpha', state: first.state }, first.cookie)
    await db.update(schema.users).set({ status: 'disabled' })

    stubUpstream(
      googleRoutes({ sub: 'google-subject-4', email: 'blocked@example.com', email_verified: true }),
    )
    const second = await startFlow('google')
    const response = await callback(
      'google',
      { code: 'code-beta', state: second.state },
      second.cookie,
    )
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/image?auth_error=account_disabled&login=1',
    )
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeNull()
  })
  it('preserves same-origin BFF return targets with wildcard CORS', async () => {
    const previousCors = config.corsOrigins
    config.corsOrigins = '*'
    try {
      enableGoogle()
      const start = await request(
        `/api/auth/oauth/google/start?frontend_origin=${encodeURIComponent('https://api.example.com')}&return_to=${encodeURIComponent('/assets')}`,
      )
      const location = new URL(start.headers.get('location') ?? '')
      const state = location.searchParams.get('state') ?? ''
      const stateCookie = readCookie(start, 'image_playground_oauth_state')
      const returnToCookie = readCookie(start, 'image_playground_oauth_return_to')
      if (!stateCookie || !returnToCookie) throw new Error('start did not issue OAuth cookies')
      const response = await callback(
        'google',
        { error: 'access_denied', state },
        stateCookie,
        returnToCookie,
      )
      expect(response.headers.get('location')).toBe(
        'https://api.example.com/assets?auth_error=access_denied&login=1',
      )

      const externalStart = await request(
        `/api/auth/oauth/google/start?frontend_origin=${encodeURIComponent('https://evil.example.com')}&return_to=${encodeURIComponent('/assets')}`,
      )
      const externalLocation = new URL(externalStart.headers.get('location') ?? '')
      const externalState = externalLocation.searchParams.get('state') ?? ''
      const externalStateCookie = readCookie(externalStart, 'image_playground_oauth_state')
      const externalReturnToCookie = readCookie(externalStart, 'image_playground_oauth_return_to')
      if (!externalStateCookie || !externalReturnToCookie)
        throw new Error('external start did not issue OAuth cookies')
      const externalResponse = await callback(
        'google',
        { error: 'access_denied', state: externalState },
        externalStateCookie,
        externalReturnToCookie,
      )
      expect(externalResponse.headers.get('location')).toBe(
        'https://api.example.com/assets?auth_error=access_denied&login=1',
      )
    } finally {
      config.corsOrigins = previousCors
    }
  })
})

describe('origin login policy', () => {
  const enterprise = 'https://other.example.com'
  const paid = 'https://app.example.com'
  const policy = { password: false, registration: false, providers: ['starlight'] }

  function restrictEnterprise(): void {
    process.env.AUTH_LOGIN_METHODS_BY_ORIGIN = JSON.stringify({ [enterprise]: policy })
    enableGoogle()
    enableStarlight()
  }

  function post(path: string, body: unknown, origin?: string, apiOrigin = 'https://api.example.com') {
    return app.handle(new Request(`${apiOrigin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    }))
  }

  it('filters enterprise discovery and keeps paid defaults; browser Origin overrides query', async () => {
    restrictEnterprise()
    const response = await request(`/api/auth/oauth/providers?frontend_origin=${paid}`, { origin: enterprise })
    expect(await response.json()).toEqual({
      providers: [{ id: 'starlight', label: 'Starlight' }],
      loginMethods: { password: false, registration: false },
    })
    const paidResponse = await request(`/api/auth/oauth/providers?frontend_origin=${paid}`)
    expect(await paidResponse.json()).toEqual({
      providers: [{ id: 'google', label: 'Google' }, { id: 'starlight', label: 'Starlight' }],
      loginMethods: { password: true, registration: true },
    })
    const enterpriseResponse = await request(`/api/auth/oauth/providers?frontend_origin=${enterprise}`)
    expect((await enterpriseResponse.json()).loginMethods.password).toBe(false)
  })

  it('rejects unknown origins instead of falling back to paid entry', async () => {
    restrictEnterprise()
    for (const origin of ['https://untrusted.example', 'null', `${enterprise}/`, 'not-an-origin']) {
      const query = `frontend_origin=${encodeURIComponent(origin)}`
      expect((await request(`/api/auth/oauth/providers?${query}`)).status).toBe(403)
      expect((await request(`/api/auth/oauth/google/start?${query}`)).status).toBe(403)
      expect((await request('/api/auth/oauth/providers', { origin })).status).toBe(403)
    }
  })

  it('rejects direct disabled-provider start but allows paid Google and enterprise private login', async () => {
    restrictEnterprise()
    expect((await request(`/api/auth/oauth/google/start?frontend_origin=${enterprise}`)).status).toBe(403)
    expect((await request('/api/auth/oauth/google/start', { origin: enterprise })).status).toBe(403)
    expect((await request(`/api/auth/oauth/google/start?frontend_origin=${paid}`)).status).toBe(302)
    const start = await request(`/api/auth/oauth/starlight/start?frontend_origin=${enterprise}&return_to=/device`)
    expect(start.status).toBe(302)
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const response = await callback('starlight', { code: 'enterprise-login', state },
      readCookie(start, 'image_playground_oauth_state') ?? undefined,
      readCookie(start, 'image_playground_oauth_return_to') ?? undefined)
    expect(response.headers.get('location')).toBe(`${enterprise}/device?auth_session=1`)
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeTruthy()
  })

  it('rechecks callback policy and requires return metadata bound to the provider and state', async () => {
    enableGoogle()
    const start = await request(`/api/auth/oauth/google/start?frontend_origin=${enterprise}`)
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const stateCookie = readCookie(start, 'image_playground_oauth_state') ?? undefined
    const returnCookie = readCookie(start, 'image_playground_oauth_return_to') ?? undefined
    restrictEnterprise()
    const calls = stubUpstream({})
    const response = await callback('google', { code: 'blocked', state }, stateCookie, returnCookie)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'provider_unavailable' })
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeNull()
    expect(calls).toHaveLength(0)
    for (const metadata of [undefined, returnCookie?.replace('google:', 'starlight:'), 'malformed']) {
      expect((await callback('google', { code: 'blocked', state }, stateCookie, metadata)).status).toBe(403)
    }
  })

  it('blocks password, email signup, verification and password-setting POSTs without query bypass', async () => {
    restrictEnterprise()
    const cases: [string, unknown][] = [
      ['/api/auth/login', { username: 'member@example.com', password: 'correct-password' }],
      ['/api/auth/register', { username: 'member@example.com', password: 'correct-password' }],
      ['/api/auth/register/verification', { email: 'member@example.com' }],
      ['/api/auth/password', { new_password: 'correct-password' }],
    ]
    for (const [path, body] of cases) {
      const response = await post(`${path}?frontend_origin=${paid}`, body, enterprise)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'login_method_unavailable' })
      expect((await post(`${path}?frontend_origin=${paid}`, body, undefined, enterprise)).status).toBe(403)
    }
  })

  it('preserves paid password registration, login and session access from either origin', async () => {
    restrictEnterprise()
    const body = { username: 'paid@example.com', password: 'paid-password-secret' }
    expect((await post('/api/auth/register', body, paid)).status).toBe(201)
    const login = await post('/api/auth/login', body, paid)
    expect(login.status).toBe(200)
    const session = readCookie(login, USER_SESSION_COOKIE)
    expect(session).toBeTruthy()
    const profile = await request('/api/auth/me', { origin: enterprise, cookie: `${USER_SESSION_COOKIE}=${session}` })
    expect(profile.status).toBe(200)
    const passwordChange = await app.handle(new Request('https://api.example.com/api/auth/password', {
      method: 'POST',
      headers: { origin: paid, cookie: `${USER_SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: body.password, new_password: 'replacement-paid-password' }),
    }))
    expect(passwordChange.status).toBe(200)
  })

  it('preserves paid Google callback when another origin is restricted', async () => {
    restrictEnterprise()
    stubUpstream(googleRoutes({ sub: 'paid-google', email: 'paid-google@example.com', email_verified: true }))
    const start = await request(`/api/auth/oauth/google/start?frontend_origin=${paid}`)
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? ''
    const response = await callback('google', { code: 'paid-google', state },
      readCookie(start, 'image_playground_oauth_state') ?? undefined,
      readCookie(start, 'image_playground_oauth_return_to') ?? undefined)
    expect(response.headers.get('location')).toBe(`${paid}/image?auth_session=1`)
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeTruthy()
  })

  it('uses same-origin API policy when POST has no Origin, ignoring frontend query', async () => {
    restrictEnterprise()
    const previousOrigins = process.env.AUTH_FRONTEND_ORIGINS
    process.env.AUTH_FRONTEND_ORIGINS = `${paid},${enterprise},https://api.example.com`
    process.env.AUTH_LOGIN_METHODS_BY_ORIGIN = JSON.stringify({ 'https://api.example.com': policy })
    try {
      const response = await post(`/api/auth/login?frontend_origin=${paid}`, { username: 'paid@example.com', password: 'password' })
      expect(response.status).toBe(403)
    } finally {
      if (previousOrigins === undefined) delete process.env.AUTH_FRONTEND_ORIGINS
      else process.env.AUTH_FRONTEND_ORIGINS = previousOrigins
    }
  })

  it('treats explicit empty providers as deny-all rather than default providers', async () => {
    restrictEnterprise()
    process.env.AUTH_LOGIN_METHODS_BY_ORIGIN = JSON.stringify({ [enterprise]: { ...policy, providers: [] } })
    const response = await request(`/api/auth/oauth/providers?frontend_origin=${enterprise}`)
    expect((await response.json()).providers).toEqual([])
    expect((await request(`/api/auth/oauth/starlight/start?frontend_origin=${enterprise}`)).status).toBe(403)
  })

  it('rejects malformed JSON, origins, booleans, provider ids and unknown policy keys', () => {
    const invalid = [
      '{', 'null', '[]',
      JSON.stringify({ [enterprise]: { ...policy, password: 'false' } }),
      JSON.stringify({ [enterprise]: { ...policy, registration: 0 } }),
      JSON.stringify({ [enterprise]: { ...policy, providers: 'google' } }),
      JSON.stringify({ [enterprise]: { ...policy, providers: ['not a provider'] } }),
      JSON.stringify({ [enterprise]: { ...policy, unexpected: true } }),
      JSON.stringify({ [`${enterprise}/path`]: policy }),
      JSON.stringify({ [`${enterprise}/`]: policy }),
      JSON.stringify({ 'https://not-allowlisted.example': policy }),
      JSON.stringify({ 'ftp://other.example.com': policy }),
      JSON.stringify({ 'https://user@other.example.com': policy }),
    ]
    for (const source of invalid) {
      process.env.AUTH_LOGIN_METHODS_BY_ORIGIN = source
      expect(() => config.assertValid()).toThrow('AUTH_LOGIN_METHODS_BY_ORIGIN')
    }
    restrictEnterprise()
    expect(() => config.assertValid()).not.toThrow()
  })
})
