// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { downloadImagesByIds } from '../../lib/downloadImages'
import { captureClientErrors } from '../helpers/clientErrors'

vi.mock('../../lib/imageSource', () => ({
  loadImageOriginal: async (id: string) => `https://storage.test/${id}`,
}))

const clicked = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  clicked.mockClear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(clicked)
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:download'),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('recovers a transient fetch failure without reporting a terminal failure', async () => {
  const reports = captureClientErrors()
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockResolvedValueOnce(new Response('image', { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetch)
  const result = downloadImagesByIds(['image'])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await result).toEqual({ success: 1, failed: 0 })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(clicked).toHaveBeenCalledTimes(1)
  expect(await reports()).toEqual([])
})

it.each([401, 403, 404, 422])('does not download or retry an HTTP %s response', async (status) => {
  const reports = captureClientErrors()
  const fetch = vi.fn().mockResolvedValue(new Response('error page', { status }))
  vi.stubGlobal('fetch', fetch)
  const result = downloadImagesByIds(['image'])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await result).toEqual({ success: 0, failed: 1 })
  expect(clicked).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  const errors = (await reports()).flatMap((batch) => batch.errors)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.context).toMatchObject({ stage: 'fetch', status })
})

it('bounds retries and continues to the next image after exhaustion', async () => {
  const reports = captureClientErrors()
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/broken')
      ? new Response('unavailable', { status: 503 })
      : new Response('image', { headers: { 'content-type': 'image/png' } }),
  )
  vi.stubGlobal('fetch', fetch)
  const result = downloadImagesByIds(['broken', 'ready'])
  await vi.advanceTimersByTimeAsync(3_000)
  expect(await result).toEqual({ success: 1, failed: 1 })
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(clicked).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  expect((await reports()).flatMap((batch) => batch.errors)).toHaveLength(1)
})

it('retries a failed response body before triggering a single download', async () => {
  const broken = new Response('partial')
  vi.spyOn(broken, 'blob').mockRejectedValue(new TypeError('connection interrupted'))
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(broken)
    .mockResolvedValueOnce(new Response('complete', { headers: { 'content-type': 'image/png' } }))
  vi.stubGlobal('fetch', fetch)
  const result = downloadImagesByIds(['image'])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(await result).toEqual({ success: 1, failed: 0 })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(clicked).toHaveBeenCalledTimes(1)
})
