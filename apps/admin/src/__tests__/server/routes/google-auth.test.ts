import { afterEach, describe, expect, it } from 'bun:test'

process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.ADMIN_GOOGLE_CLIENT_ID = 'admin-client-fixture'
process.env.ADMIN_GOOGLE_CLIENT_SECRET = 'admin-secret-fixture'
process.env.ADMIN_GOOGLE_ALLOWED_EMAILS = ' Owner@Example.com , second@example.com '
process.env.ADMIN_PUBLIC_ORIGIN = 'https://admin.example.com'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'
delete process.env.ADMIN_PASSWORD

const { app } = await import('../../../../server/app')
const { setGoogleFetchForTesting } = await import('../../../../server/lib/google-oauth')

const CALLBACK_URI = 'https://admin.example.com/api/auth/google/callback'

interface UpstreamCall {
  url: string
  body: string
  authorization: string | null
}

/** Stubs Google's token and userinfo endpoints; returns the calls the route made. */
function stubGoogle(profile: unknown, options: { tokenStatus?: number } = {}): UpstreamCall[] {
  const calls: UpstreamCall[] = []
  setGoogleFetchForTesting(async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: new Headers(init?.headers).get('authorization'),
    })
    if (url.includes('/token')) {
      if (options.tokenStatus && options.tokenStatus !== 200) {
        return new Response('nope', { status: options.tokenStatus })
      }
      return Response.json({ access_token: 'google-grant-alpha' })
    }
    return Response.json(profile)
  })
  return calls
}

function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(new Request(`https://admin.example.com${path}`, { headers }))
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

async function startFlow(
  redirect?: string,
  ip = '10.1.0.0',
): Promise<{ state: string; cookie: string }> {
  const query = redirect ? `?redirect=${encodeURIComponent(redirect)}` : ''
  const response = await request(`/api/auth/google${query}`, { 'cf-connecting-ip': ip })
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '')
  const cookie = readCookie(response, 'admin_oauth_state')
  if (!cookie) throw new Error('start did not issue a state cookie')
  return { state: location.searchParams.get('state') ?? '', cookie }
}

function callback(
  query: Record<string, string>,
  stateCookie: string | undefined,
  ip: string,
): Promise<Response> {
  const headers: Record<string, string> = { 'cf-connecting-ip': ip }
  if (stateCookie) headers.cookie = `admin_oauth_state=${encodeURIComponent(stateCookie)}`
  return request(`/api/auth/google/callback?${new URLSearchParams(query).toString()}`, headers)
}

afterEach(() => {
  setGoogleFetchForTesting()
})

describe('GET /api/auth/methods', () => {
  it('advertises Google login and retires the shared password', async () => {
    const response = await request('/api/auth/methods')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ google_login: true, password_login: false })
  })
})

describe('POST /api/login', () => {
  it('refuses the shared password once Google login is configured', async () => {
    const response = await app.handle(
      new Request('https://admin.example.com/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.1.0.9' },
        body: JSON.stringify({ password: 'anything-at-all' }),
      }),
    )
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'password_login_disabled' })
  })
})

describe('GET /api/auth/google', () => {
  it('redirects to Google with PKCE and the configured callback', async () => {
    const response = await request('/api/auth/google', { 'cf-connecting-ip': '10.1.0.1' })
    expect(response.status).toBe(302)

    const location = new URL(response.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    )
    expect(location.searchParams.get('client_id')).toBe('admin-client-fixture')
    expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK_URI)
    expect(location.searchParams.get('response_type')).toBe('code')
    expect(location.searchParams.get('scope')).toBe('openid email')
    expect(location.searchParams.get('prompt')).toBe('select_account')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(readCookie(response, 'admin_oauth_state')).toBeTruthy()
  })
})

describe('GET /api/auth/google/callback', () => {
  it('signs a session for an allowlisted address and honours the stored redirect', async () => {
    const calls = stubGoogle({ email: 'OWNER@example.com', email_verified: true })
    const { state, cookie } = await startFlow('/tasks', '10.1.1.1')
    const response = await callback({ code: 'code-alpha', state }, cookie, '10.1.1.1')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/tasks')
    expect(readCookie(response, 'admin_session')).toBeTruthy()

    const exchange = new URLSearchParams(calls[0]?.body ?? '')
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('code')).toBe('code-alpha')
    expect(exchange.get('client_secret')).toBe('admin-secret-fixture')
    expect(exchange.get('redirect_uri')).toBe(CALLBACK_URI)
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(calls[1]?.authorization).toBe('Bearer google-grant-alpha')
  })

  it('defaults to the console root when the flow carried no redirect', async () => {
    stubGoogle({ email: 'second@example.com', email_verified: true })
    const { state, cookie } = await startFlow(undefined, '10.1.1.2')
    const response = await callback({ code: 'code-beta', state }, cookie, '10.1.1.2')

    expect(response.headers.get('location')).toBe('/')
    expect(readCookie(response, 'admin_session')).toBeTruthy()
  })

  it('rejects an address outside the allowlist', async () => {
    stubGoogle({ email: 'stranger@example.com', email_verified: true })
    const { state, cookie } = await startFlow('/tasks', '10.1.2.1')
    const response = await callback({ code: 'code-gamma', state }, cookie, '10.1.2.1')

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/login?error=not_allowed')
    expect(readCookie(response, 'admin_session')).toBeNull()
  })

  it('rejects an unverified address that is on the allowlist', async () => {
    stubGoogle({ email: 'owner@example.com', email_verified: false })
    const { state, cookie } = await startFlow('/tasks', '10.1.2.2')
    const response = await callback({ code: 'code-delta', state }, cookie, '10.1.2.2')

    expect(response.headers.get('location')).toBe('/login?error=not_allowed')
    expect(readCookie(response, 'admin_session')).toBeNull()
  })

  it('rejects a state that does not match the cookie', async () => {
    stubGoogle({ email: 'owner@example.com', email_verified: true })
    const { cookie } = await startFlow('/tasks', '10.1.3.1')
    const response = await callback({ code: 'code-eps', state: 'forged' }, cookie, '10.1.3.1')

    expect(response.headers.get('location')).toBe('/login?error=oauth_failed')
    expect(readCookie(response, 'admin_session')).toBeNull()
  })

  it('rejects a callback that carries no state cookie', async () => {
    stubGoogle({ email: 'owner@example.com', email_verified: true })
    const response = await callback({ code: 'code-zeta', state: 'orphan' }, undefined, '10.1.3.2')

    expect(response.headers.get('location')).toBe('/login?error=oauth_failed')
    expect(readCookie(response, 'admin_session')).toBeNull()
  })

  it('reports a failed code exchange as oauth_failed', async () => {
    stubGoogle({}, { tokenStatus: 401 })
    const { state, cookie } = await startFlow('/tasks', '10.1.4.1')
    const response = await callback({ code: 'code-eta', state }, cookie, '10.1.4.1')

    expect(response.headers.get('location')).toBe('/login?error=oauth_failed')
    expect(readCookie(response, 'admin_session')).toBeNull()
  })

  it('locks the address out after the sixth failed callback', async () => {
    stubGoogle({ email: 'stranger@example.com', email_verified: true })
    const ip = '10.1.5.1'
    for (let i = 0; i < 5; i++) {
      const { state, cookie } = await startFlow('/tasks', ip)
      const response = await callback({ code: `code-${i}`, state }, cookie, ip)
      expect(response.status).toBe(302)
    }
    const { state, cookie } = await startFlow('/tasks', ip)
    expect((await callback({ code: 'code-6', state }, cookie, ip)).status).toBe(302)
    expect((await callback({ code: 'code-7', state }, cookie, ip)).status).toBe(429)
  })
})
