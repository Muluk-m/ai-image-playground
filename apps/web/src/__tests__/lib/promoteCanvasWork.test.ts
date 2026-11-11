// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn())
const refresh = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../lib/authClient', () => ({ authenticatedBffFetch: fetchMock }))
vi.mock('../../lib/platformGenerations', () => ({ refreshPlatformGeneration: refresh }))
vi.mock('../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'https://bff.test' }))

import { setClientStorageScope } from '../../lib/authScope'
import { promoteCanvasQueueOutput, resumePendingCanvasPromotes } from '../../lib/promoteCanvasWork'

const TASK = '11111111-1111-4111-8111-111111111111'
const EXPIRED = '22222222-2222-4222-8222-222222222222'
const PENDING = '33333333-3333-4333-8333-333333333333'

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  sessionStorage.clear()
  setClientStorageScope('promote-account')
  fetchMock.mockReset()
  refresh.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  setClientStorageScope(null)
})

it('retries a retryable promote after one second and then records the work', async () => {
  fetchMock
    .mockResolvedValueOnce(json(503, { error: 'media_pending', retryable: true }))
    .mockResolvedValueOnce(json(200, { id: TASK, outputs: [{ index: 0 }] }))
  promoteCanvasQueueOutput(TASK, 0)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  expect(refresh).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(999)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not retry an image the server rejected', async () => {
  fetchMock.mockResolvedValue(json(422, { error: 'media_invalid_image' }))
  promoteCanvasQueueOutput('44444444-4444-4444-8444-444444444444', 0)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(12_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('does not retry an expired candidate', async () => {
  fetchMock.mockResolvedValue(json(409, { error: 'candidate_expired' }))
  promoteCanvasQueueOutput(EXPIRED, 0)
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(12_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(refresh).not.toHaveBeenCalled()
})

it('keeps a failed promote pending so the next open can finish it', async () => {
  fetchMock.mockResolvedValue(json(503, { error: 'storage_unavailable', retryable: true }))
  promoteCanvasQueueOutput(PENDING, 1)
  await vi.advanceTimersByTimeAsync(12_000)
  await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(4))
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(json(200, { id: PENDING, outputs: [{ index: 1 }] }))
  resumePendingCanvasPromotes()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
})
