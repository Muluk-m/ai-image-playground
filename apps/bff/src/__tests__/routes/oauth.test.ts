import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
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

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setOAuthFetchForTesting } = await import('../../lib/oauth')
const { USER_SESSION_COOKIE } = await import('../../lib/user-session')

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const FEISHU_TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const FEISHU_USERINFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

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
): Promise<Response> {
  const search = new URLSearchParams(query).toString()
  return request(
    `/api/auth/oauth/${provider}/callback?${search}`,
    stateCookie
      ? { cookie: `image_playground_oauth_state=${encodeURIComponent(stateCookie)}` }
      : {},
  )
}

function enableGoogle(): void {
  process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'google-secret-fixture'
}

function enableFeishu(): void {
  process.env.OAUTH_FEISHU_APP_ID = 'cli_fixture'
  process.env.OAUTH_FEISHU_APP_SECRET = 'feishu-secret-fixture'
}

function disableAllProviders(): void {
  process.env.OAUTH_GOOGLE_CLIENT_ID = ''
  process.env.OAUTH_GOOGLE_CLIENT_SECRET = ''
  process.env.OAUTH_FEISHU_APP_ID = ''
  process.env.OAUTH_FEISHU_APP_SECRET = ''
  process.env.OAUTH_FEISHU_SCOPE = ''
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
  _setPrivateBffOverlayForTesting()
  setOAuthFetchForTesting()
  await closeDb()
})

describe('oauth provider discovery', () => {
  it('lists nothing while no provider has both secrets', async () => {
    process.env.OAUTH_GOOGLE_CLIENT_ID = 'google-client-fixture'
    const response = await request('/api/auth/oauth/providers')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ providers: [] })
  })

  it('lists every fully configured provider without leaking secrets', async () => {
    enableGoogle()
    enableFeishu()
    const response = await request('/api/auth/oauth/providers')
    const body = (await response.json()) as { providers: unknown[] }
    expect(body.providers).toEqual([
      { id: 'google', label: 'Google' },
      { id: 'feishu', label: '飞书' },
    ])
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('oauth start', () => {
  it('rejects an unconfigured or unknown provider', async () => {
    expect((await request('/api/auth/oauth/google/start')).status).toBe(404)
    expect((await request('/api/auth/oauth/myspace/start')).status).toBe(404)
  })

  it('redirects to Google with a state cookie bound to the provider', async () => {
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

    const cookie = readCookie(response, 'image_playground_oauth_state')
    expect(cookie).toBe(`google:${location.searchParams.get('state')}`)
  })

  it('omits the Feishu scope until an operator opts in', async () => {
    enableFeishu()
    const withoutScope = new URL(
      (await request('/api/auth/oauth/feishu/start')).headers.get('location') ?? '',
    )
    expect(`${withoutScope.origin}${withoutScope.pathname}`).toBe(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    )
    expect(withoutScope.searchParams.has('scope')).toBe(false)

    process.env.OAUTH_FEISHU_SCOPE = 'contact:user.email:readonly'
    const withScope = new URL(
      (await request('/api/auth/oauth/feishu/start')).headers.get('location') ?? '',
    )
    expect(withScope.searchParams.get('scope')).toBe('contact:user.email:readonly')
  })
})

describe('oauth callback', () => {
  it('rejects an unconfigured provider', async () => {
    expect((await callback('google', { code: 'x', state: 'y' })).status).toBe(404)
  })

  it('rejects a missing, foreign, or cross-provider state', async () => {
    enableGoogle()
    enableFeishu()
    const { state, cookie } = await startFlow('google')

    expect((await callback('google', { code: 'c', state })).status).toBe(403)
    expect((await callback('google', { code: 'c', state: 'forged' }, cookie)).status).toBe(403)
    expect((await callback('feishu', { code: 'c', state }, cookie)).status).toBe(403)
  })

  it('redirects with auth_error when the provider reports a denial', async () => {
    enableGoogle()
    const { state, cookie } = await startFlow('google')
    const response = await callback('google', { error: 'access_denied', state }, cookie)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_error=access_denied',
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
      'https://app.example.com/?auth_error=exchange_failed',
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
      'https://app.example.com/?auth_error=identity_failed',
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
    expect(response.headers.get('location')).toBe('https://app.example.com/')

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
    expect(user?.id).toBe(identity?.user_id ?? '')
    expect(createdUserIds).toEqual([user?.id ?? ''])

    const sessionToken = readCookie(response, USER_SESSION_COOKIE)
    expect(sessionToken).toBeTruthy()
    const me = await request('/api/auth/me', {
      cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
    })
    expect(await me.json()).toEqual({ user: { id: user?.id, username: 'creator@example.com' } })
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

    expect(response.headers.get('location')).toBe('https://app.example.com/')
    expect(await db.select().from(schema.users)).toHaveLength(1)
    expect(await db.select().from(schema.user_identities)).toHaveLength(1)
    expect(createdUserIds).toHaveLength(1)
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeTruthy()
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

  it('signs in a Feishu subject by union_id and stores the profile email', async () => {
    enableFeishu()
    const calls = stubUpstream({
      [FEISHU_TOKEN_ENDPOINT]: () =>
        Response.json({ code: 0, access_token: 'u-feishu-grant', token_type: 'Bearer' }),
      [FEISHU_USERINFO_ENDPOINT]: () =>
        Response.json({
          code: 0,
          data: {
            open_id: 'ou_open_1',
            union_id: 'on_union_1',
            email: 'staff@qiliangjia.com',
            name: '张三',
          },
        }),
    })
    const { state, cookie } = await startFlow('feishu')
    const response = await callback('feishu', { code: 'feishu-code', state }, cookie)

    expect(response.headers.get('location')).toBe('https://app.example.com/')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cli_fixture',
      client_secret: 'feishu-secret-fixture',
      code: 'feishu-code',
      redirect_uri: 'https://api.example.com/api/auth/oauth/feishu/callback',
    })
    expect(calls[1]?.authorization).toBe('Bearer u-feishu-grant')

    const [identity] = await db.select().from(schema.user_identities)
    expect(identity?.subject).toBe('on_union_1')
    expect(identity?.email).toBe('staff@qiliangjia.com')
    expect(identity?.display_name).toBe('张三')
    const [user] = await db.select().from(schema.users)
    expect(user?.username).toBe('staff@qiliangjia.com')
  })

  it('treats a non-zero Feishu business code as a failed exchange', async () => {
    enableFeishu()
    stubUpstream({
      [FEISHU_TOKEN_ENDPOINT]: () =>
        Response.json({ code: 20037, error: 'invalid_grant', error_description: 'expired' }),
    })
    const { state, cookie } = await startFlow('feishu')
    const response = await callback('feishu', { code: 'stale', state }, cookie)
    expect(response.headers.get('location')).toBe(
      'https://app.example.com/?auth_error=exchange_failed',
    )
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
      'https://app.example.com/?auth_error=account_disabled',
    )
    expect(readCookie(response, USER_SESSION_COOKIE)).toBeNull()
  })
})
