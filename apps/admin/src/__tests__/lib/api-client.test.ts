import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetApiClientRefsForTest,
  ApiError,
  apiClient,
  setApiClientRefs,
  UnauthorizedError,
} from '../../lib/api-client'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('api-client', () => {
  const navigate = vi.fn()
  const fakeRouter = { navigate } as unknown as Parameters<typeof setApiClientRefs>[0]['router']
  let queryClient: QueryClient
  let clearSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    navigate.mockReset()
    queryClient = new QueryClient()
    clearSpy = vi.spyOn(queryClient, 'clear')
    setApiClientRefs({ router: fakeRouter, queryClient })
  })

  afterEach(() => {
    _resetApiClientRefsForTest()
    vi.restoreAllMocks()
  })

  it('200 returns parsed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true, value: 42 })),
    )
    const out = await apiClient.get<{ ok: boolean; value: number }>('/api/foo')
    expect(out).toEqual({ ok: true, value: 42 })
    expect(clearSpy).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('401 throws UnauthorizedError + clears query cache + navigates /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' })),
    )
    await expect(apiClient.get('/api/me')).rejects.toBeInstanceOf(UnauthorizedError)
    expect(clearSpy).toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledWith({ to: '/login' })
  })

  it('500 throws ApiError, does not navigate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })))
    const err = await apiClient.get('/api/foo').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(UnauthorizedError)
    expect((err as ApiError).status).toBe(500)
    expect(clearSpy).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('post() sends JSON body with credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    await apiClient.post('/api/login', { password: 'secret' })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ password: 'secret' }),
      }),
    )
  })
})
