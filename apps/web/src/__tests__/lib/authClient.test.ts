import { BAKED_DEFAULTS } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTH_SESSION_EXPIRED_EVENT,
  authenticatedBffFetch,
  getCurrentUser,
  loginUser,
  logoutUser,
} from '../../lib/authClient'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

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
          'accounts:login': true,
          'billing:credits': false,
          'generation:byok': true,
          'quota:daily': false,
        }),
      ),
    )
    await bootstrapClientCapabilities(true, 'https://bff.example.com')
    vi.unstubAllGlobals()
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

  it('includes cookies on queue requests and announces an expired session', async () => {
    const events = new EventTarget()
    const expired = vi.fn()
    events.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    vi.stubGlobal('window', events)

    const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchSpy)

    await authenticatedBffFetch('/v1/queue/requests/id/status', { cache: 'no-store' })

    expect(fetchSpy).toHaveBeenCalledWith('/v1/queue/requests/id/status', {
      cache: 'no-store',
      credentials: 'include',
    })
    expect(expired).toHaveBeenCalledOnce()
  })
})
