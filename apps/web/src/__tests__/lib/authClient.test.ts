import { BAKED_DEFAULTS } from '@image-playground/shared'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSignedIn } from '../../auth/loginPrompt'
import {
  AUTH_SESSION_EXPIRED_EVENT,
  authenticatedBffFetch,
  fetchCliConnections,
  fetchLoginOptions,
  fetchOAuthProviders,
  getCurrentUser,
  loginUser,
  logoutUser,
  oauthLinkUrl,
  oauthStartUrl,
  refreshWebSession,
  registerUser,
  revokeCliConnection,
  shouldProbeSession,
} from '../../lib/authClient'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'
import { allCapabilitiesOff } from '../fixtures/capabilities'

const USER = {
  id: 'user-1',
  username: 'alice',
  status: 'active' as const,
}

describe('auth client', () => {
  beforeEach(async () => {
    _setRuntimeConfigForTesting({
      ...BAKED_DEFAULTS,
      bff: { enabled: true, baseUrl: 'https://bff.example.com' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ...allCapabilitiesOff(),
          'accounts:login': true,
          'accounts:self-register': true,
          'generation:byok': true,
        }),
      ),
    )
    await bootstrapClientCapabilities(true, 'https://bff.example.com')
    vi.unstubAllGlobals()
    vi.stubGlobal('indexedDB', new IDBFactory())
    setSignedIn(false)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    _setRuntimeConfigForTesting(BAKED_DEFAULTS)
    await bootstrapClientCapabilities(false, '')
  })

  it('logs in with JSON and an included credential cookie', async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ user: USER }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await expect(loginUser(' alice ', 'secret')).resolves.toEqual(USER)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://bff.example.com/api/auth/login')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ username: ' alice ', password: 'secret' }),
    })
  })

  it('registers with JSON and an included credential cookie', async () => {
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ user: USER }, { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    await expect(registerUser(' new-user ', 'fixture-phrase')).resolves.toEqual(USER)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://bff.example.com/api/auth/register')
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ username: ' new-user ', password: 'fixture-phrase' }),
    })
  })

  it('loads the current user and logs out through the BFF', async () => {
    let callIndex = 0
    const fetchSpy = vi.fn(async (_input: string, _init?: RequestInit) => {
      callIndex++
      return callIndex === 1 ? Response.json({ user: USER }) : Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await expect(getCurrentUser()).resolves.toEqual(USER)
    await expect(logoutUser()).resolves.toBeUndefined()

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://bff.example.com/api/auth/me')
    expect(fetchSpy.mock.calls[1]).toEqual([
      'https://bff.example.com/api/auth/logout',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    ])
  })

  it('preserves a safe server error code without exposing response details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'invalid_credentials', debug: 'hidden' }, { status: 401 }),
      ),
    )

    await expect(loginUser('alice', 'wrong')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    })
  })

  it('includes cookies on queue requests and announces an expired session only after refresh fails', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', {})
    setSignedIn(true)

    const fetchSpy = vi.fn(async (input: string) => {
      if (String(input).endsWith('/api/auth/refresh')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 })
      }
      return new Response(null, { status: 401 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await authenticatedBffFetch('/v1/queue/requests/id/status', { cache: 'no-store' })

    expect(fetchSpy).toHaveBeenCalledWith('/v1/queue/requests/id/status', {
      cache: 'no-store',
      credentials: 'include',
    })
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/refresh')),
    ).toHaveLength(1)
    expect(expired).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent 401s into one refresh and retries without a login prompt', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)
    const locks: string[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: async (_name: string, callback: () => Promise<unknown>) => {
          locks.push('acquired')
          return callback()
        },
      },
    })
    setSignedIn(true)
    const attempts = new Map<string, number>()
    const fetchSpy = vi.fn(async (input: string) => {
      const url = String(input)
      if (url.endsWith('/api/auth/refresh')) {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return Response.json({ ok: true })
      }
      const seen = (attempts.get(url) ?? 0) + 1
      attempts.set(url, seen)
      return seen === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => authenticatedBffFetch('/api/projects')),
    )

    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 10 }, () => 200),
    )
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/refresh')),
    ).toHaveLength(1)
    expect(locks).toEqual(['acquired'])
    expect(expired).not.toHaveBeenCalled()
  })

  it('treats a raced refresh as success and retries the original request', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', {})
    setSignedIn(true)
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input).endsWith('/api/auth/refresh')) {
          return Response.json({ error: 'refresh_raced' }, { status: 409 })
        }
        calls += 1
        return calls === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true })
      }),
    )

    const response = await authenticatedBffFetch('/api/projects')

    expect(response.status).toBe(200)
    expect(expired).not.toHaveBeenCalled()
  })

  it('refreshes once more after a raced refresh before showing the login prompt', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)
    vi.stubGlobal('navigator', {})
    setSignedIn(true)
    let refreshes = 0
    let projectCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input).endsWith('/api/auth/refresh')) {
          refreshes += 1
          return refreshes === 1
            ? Response.json({ error: 'refresh_raced' }, { status: 409 })
            : Response.json({ ok: true, access_expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000 })
        }
        projectCalls += 1
        return projectCalls < 3 ? new Response(null, { status: 401 }) : Response.json({ ok: true })
      }),
    )

    const response = await authenticatedBffFetch('/api/projects')

    expect(response.status).toBe(200)
    expect(refreshes).toBe(2)
    expect(expired).not.toHaveBeenCalled()
  })

  it('keeps a durable request identity after a lost response, including across module reload', async () => {
    vi.stubGlobal('navigator', {})
    let firstKey: string | null = null
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const key = new Headers(init?.headers).get('x-session-refresh-request')
      if (!firstKey) {
        firstKey = key
        throw new TypeError('response lost')
      }
      expect(key).toBe(firstKey)
      return Response.json({ ok: true, access_expires_at: Date.now() + 60_000 })
    })
    vi.stubGlobal('fetch', fetchSpy)
    expect(await refreshWebSession()).toBe('failed')
    vi.resetModules()
    const config = await import('../../lib/runtimeConfig')
    config._setRuntimeConfigForTesting({
      bff: { enabled: true, baseUrl: 'https://bff.example.com' },
    })
    const reloaded = await import('../../lib/authClient')
    expect(await reloaded.refreshWebSession()).toBe('ok')
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('keeps the same request key if response cookies arrived but the JSON body was interrupted', async () => {
    vi.stubGlobal('navigator', {})
    const keys: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get('x-session-refresh-request'))
        if (keys.length === 1)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('body lost'))
              },
            }),
          )
        return Response.json({ ok: true })
      }),
    )
    expect(await refreshWebSession()).toBe('failed')
    expect(await refreshWebSession()).toBe('ok')
    expect(keys[1]).toBe(keys[0])
  })

  it('renews once after recovering an original response whose access already expired', async () => {
    vi.stubGlobal('navigator', {})
    const keys: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get('x-session-refresh-request'))
        return Response.json({
          ok: true,
          access_expires_at: Date.now() + (keys.length === 1 ? -1_000 : 60_000),
        })
      }),
    )
    expect(await refreshWebSession()).toBe('ok')
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('uses the completed proof to recover a late cookie inside the 409 grace period', async () => {
    vi.stubGlobal('navigator', {})
    let completedKey: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        completedKey = new Headers(init?.headers).get('x-session-refresh-request')
        return Response.json({ ok: true })
      }),
    )
    expect(await refreshWebSession()).toBe('ok')
    const keys: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const key = new Headers(init?.headers).get('x-session-refresh-request')
        keys.push(key)
        return key === completedKey
          ? Response.json({ ok: true })
          : Response.json({ error: 'refresh_raced' }, { status: 409 })
      }),
    )
    expect(await refreshWebSession()).toBe('ok')
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(completedKey)
  })

  it('retires a consumed pending identity and saves a new one before rotating the valid current cookie', async () => {
    vi.stubGlobal('navigator', {})
    const keys: (string | null)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        keys.push(new Headers(init?.headers).get('x-session-refresh-request'))
        return keys.length === 1
          ? Response.json({ error: 'refresh_request_completed' }, { status: 409 })
          : Response.json({ ok: true })
      }),
    )
    expect(await refreshWebSession()).toBe('ok')
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  it('stays quiet on a 401 for a visitor who never signed in', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)
    setSignedIn(false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 })),
    )

    await authenticatedBffFetch('/v1/queue/requests/id/status')

    expect(expired).not.toHaveBeenCalled()
  })

  it('does not request the billing account for a visitor who never signed in', async () => {
    setSignedIn(false)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const response = await authenticatedBffFetch('https://bff.example.com/api/billing/account')

    expect(response.status).toBe(401)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still requests the billing account under bun, where the billing store tests run', async () => {
    vi.stubGlobal('Bun', {})
    setSignedIn(false)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const response = await authenticatedBffFetch('/api/billing/account')

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('still requests the billing account when this deployment has no accounts', async () => {
    await bootstrapClientCapabilities(false, '')
    setSignedIn(false)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const response = await authenticatedBffFetch('/api/billing/account')

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledOnce()
  })

  it('still requests the billing account after sign-in', async () => {
    setSignedIn(true)
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const response = await authenticatedBffFetch('/api/billing/account')

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledOnce()
    setSignedIn(false)
  })

  it('remembers a successful login on this page so the next load checks the session', async () => {
    const store = new Map<string, string>()
    let cookie = ''
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    vi.stubGlobal('document', {
      get cookie() {
        return cookie
      },
      set cookie(value: string) {
        cookie = value
      },
    })
    vi.stubGlobal('location', { protocol: 'https:' })
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ user: USER })),
    )

    await loginUser('alice', 'secret')

    expect(store.get('image-playground.last-storage-user')).toBe(JSON.stringify(USER.id))
    expect(cookie).toContain('image_playground_signed_in=1')
    expect(cookie).toContain('Secure')
    expect(shouldProbeSession()).toBe(true)
    await logoutUser()
    expect(store.get('image-playground.last-storage-user')).toBe('null')
    expect(cookie).toContain('Max-Age=0')
  })

  it('probes the session only when a hint cookie or a remembered user is present', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    vi.stubGlobal('document', { cookie: '' })
    expect(shouldProbeSession()).toBe(false)

    store.set('image-playground.last-storage-user', 'null')
    expect(shouldProbeSession()).toBe(false)

    store.set('image-playground.last-storage-user', JSON.stringify('alice'))
    expect(shouldProbeSession()).toBe(true)

    store.clear()
    vi.stubGlobal('document', { cookie: 'image_playground_signed_in=1' })
    expect(shouldProbeSession()).toBe(true)

    vi.stubGlobal('document', { cookie: '' })
    store.clear()
    vi.stubGlobal('window', {
      location: { search: '?auth_session=1' },
    })
    expect(shouldProbeSession()).toBe(true)
  })

  it('retains a remembered session when cookie access is blocked', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    })
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error('blocked')
      },
      set cookie(_value: string) {
        throw new Error('blocked')
      },
    })
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ user: USER })),
    )
    await expect(loginUser('alice', 'secret')).resolves.toEqual(USER)
    expect(shouldProbeSession()).toBe(true)
    await expect(logoutUser()).resolves.toBeUndefined()
    expect(shouldProbeSession()).toBe(false)
  })

  it('loads connected CLIs with the browser session and cancellation signal', async () => {
    const connections = [
      { id: 'connection-1', client_name: 'Muvloom CLI', created_at: 1, last_used_at: null },
    ]
    const fetcher = vi.fn(async () => Response.json({ connections }))
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    await expect(fetchCliConnections(controller.signal)).resolves.toEqual(connections)
    expect(fetcher).toHaveBeenCalledWith('https://bff.example.com/api/me/cli-connections', {
      credentials: 'include',
      signal: controller.signal,
    })
  })

  it.each([
    {},
    { connections: null },
    { connections: { id: 'connection-1' } },
    null,
    { connections: [null] },
    { connections: [{ id: 'c1', client_name: {}, created_at: 1, last_used_at: null }] },
    { connections: [{ id: 'c1', client_name: 'CLI', created_at: '1', last_used_at: null }] },
  ])('rejects a connection response without an array (%j)', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(body)),
    )
    await expect(fetchCliConnections()).rejects.toMatchObject({
      name: 'AuthRequestError',
      status: 200,
      code: 'invalid_response',
    })
  })

  it('revokes exactly the selected connection without exposing credentials', async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetcher)
    await expect(revokeCliConnection('connection/one')).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/me/cli-connections/connection%2Fone',
      {
        credentials: 'include',
        method: 'DELETE',
        signal: undefined,
      },
    )
  })

  it('preserves connection API errors for the account UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'capability_unavailable' }, { status: 404 })),
    )
    await expect(fetchCliConnections()).rejects.toMatchObject({
      status: 404,
      code: 'capability_unavailable',
    })
    await expect(revokeCliConnection('connection-1')).rejects.toMatchObject({
      status: 404,
      code: 'capability_unavailable',
    })
  })

  it('points the OAuth start route at the configured BFF origin and page origin', () => {
    vi.stubGlobal('window', { location: new URL('https://app.example.com/') })
    const url = new URL(oauthStartUrl('google'))
    expect(url.origin).toBe('https://bff.example.com')
    expect(url.pathname).toBe('/api/auth/oauth/google/start')
    expect(url.searchParams.get('return_to')).toBe('/image')
    expect(url.searchParams.get('frontend_origin')).toBe('https://app.example.com')
  })

  it.each([
    '/image?prompt=hello%20world&login=1#composer',
    '/assets?tab=projects#recent',
    '/explore?tag=art#results',
    '/tools?tool=resize#upload',
    '/tools/resize?from=catalog#upload',
    '/pricing?plan=pro#plans',
    '/terms#agreement',
    '/privacy#cookies',
    '/device?user_code=BCDF-GHJK#approval',
    '/changelog?from=drawer',
    '/p/project-123?mode=canvas&selection=a%2Bb#node-2',
  ])('preserves workspace query and hash for OAuth start and link at %s', (target) => {
    vi.stubGlobal('window', { location: new URL(target, 'https://app.example.com') })
    const start = new URL(oauthStartUrl('google', '  invite +&/#?  '))
    const link = new URL(oauthLinkUrl('google'))

    expect(start.origin).toBe('https://bff.example.com')
    expect(start.pathname).toBe('/api/auth/oauth/google/start')
    expect(start.searchParams.get('return_to')).toBe(target)
    expect(start.searchParams.get('frontend_origin')).toBe('https://app.example.com')
    expect(start.searchParams.get('ref')).toBe('invite +&/#?')
    expect(link.origin).toBe('https://bff.example.com')
    expect(link.pathname).toBe('/api/auth/oauth/google/link')
    expect(link.searchParams.get('return_to')).toBe(target)
    expect(link.searchParams.get('frontend_origin')).toBe('https://app.example.com')
    expect(link.searchParams.has('ref')).toBe(false)
  })

  it.each([
    '/',
    '/login?ref=invite#signup',
    '/guide/start',
    '/p/',
    '/p/%FF',
  ])('defaults website and invalid project entries to /image at %s', (target) => {
    vi.stubGlobal('window', { location: new URL(target, 'https://app.example.com') })
    expect(new URL(oauthStartUrl('google')).searchParams.get('return_to')).toBe('/image')
    expect(new URL(oauthLinkUrl('google')).searchParams.get('return_to')).toBe('/image')
  })

  it('defaults to /image without a browser and omits blank referrals', () => {
    vi.stubGlobal('window', undefined)
    const start = new URL(oauthStartUrl('google', '  '))
    expect(start.searchParams.get('return_to')).toBe('/image')
    expect(start.searchParams.has('ref')).toBe(false)
    expect(new URL(oauthLinkUrl('google')).searchParams.get('return_to')).toBe('/image')
  })

  it('defaults oversized workspace targets to /image', () => {
    vi.stubGlobal('window', {
      location: new URL(`https://app.example.com/image?prompt=${'a'.repeat(2048)}`),
    })
    expect(new URL(oauthStartUrl('google')).searchParams.get('return_to')).toBe('/image')
    expect(new URL(oauthLinkUrl('google')).searchParams.get('return_to')).toBe('/image')
  })

  it('keeps well-formed providers and drops malformed ones', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          loginMethods: { password: true, registration: true },
          providers: [
            { id: 'google', label: 'Google' },
            { id: 'later', label: 'Later' },
            { label: 'no id' },
            'nope',
          ],
        }),
      ),
    )

    // An id this bundle predates still reaches the login page: the BFF decides what exists.
    await expect(fetchOAuthProviders()).resolves.toEqual([
      { id: 'google', label: 'Google' },
      { id: 'later', label: 'Later' },
    ])
  })

  it('preserves provider-only policy and rejects absent policy instead of enabling forms', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://studio.example.com' } })
    const options = {
      providers: [{ id: 'enterprise', label: 'Enterprise' }],
      loginMethods: { password: false, registration: false },
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(options)),
    )
    await expect(fetchLoginOptions()).resolves.toEqual(options)
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toContain(
      'frontend_origin=https%3A%2F%2Fstudio.example.com',
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ providers: [] })),
    )
    await expect(fetchLoginOptions()).rejects.toThrow('invalid_login_options')
  })

  it('reports no providers when the endpoint fails or answers with the wrong shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    await expect(fetchOAuthProviders()).resolves.toEqual([])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ providers: 'all of them' })),
    )
    await expect(fetchOAuthProviders()).resolves.toEqual([])
  })
})
