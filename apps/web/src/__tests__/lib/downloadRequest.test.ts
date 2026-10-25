// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setClientStorageScope } from '../../lib/authScope'
import { fetchDownloadBlob } from '../../lib/downloadRequest'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('does not retry caller cancellation during the backoff', async () => {
  const controller = new AbortController()
  const fetch = vi.fn().mockRejectedValue(new TypeError('network'))
  vi.stubGlobal('fetch', fetch)
  const result = fetchDownloadBlob('/image', { signal: controller.signal })
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(100)
  controller.abort()
  await rejected
  await vi.advanceTimersByTimeAsync(2_000)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not retry or return bytes after switching accounts', async () => {
  setClientStorageScope('first')
  const fetch = vi.fn().mockRejectedValue(new TypeError('network'))
  vi.stubGlobal('fetch', fetch)
  const result = fetchDownloadBlob('/image')
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(100)
  setClientStorageScope('second')
  await vi.advanceTimersByTimeAsync(2_000)
  await rejected
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('uses one total deadline, including response body reads', async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => ({
    ok: true,
    blob: () => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    }),
  }))
  vi.stubGlobal('fetch', fetch)
  const result = fetchDownloadBlob('/image')
  const rejected = expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
  await vi.advanceTimersByTimeAsync(300_000)
  await rejected
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('retries an unexpected body abort while the caller is still active', async () => {
  const controller = new AbortController()
  const fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    blob: async () => { throw new DOMException('transport abort', 'AbortError') },
  }).mockResolvedValueOnce(new Response('complete'))
  vi.stubGlobal('fetch', fetch)
  const result = fetchDownloadBlob('/image', { credentials: 'include', signal: controller.signal })
  await vi.advanceTimersByTimeAsync(500)
  expect((await result).size).toBe(8)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include' })
  expect(vi.getTimerCount()).toBe(0)
})
