// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapClientCapabilities, getClientCapabilityManifest } from '../../lib/clientCapabilities'
import { transferMedia } from '../../lib/mediaTransfer'

vi.mock('../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'https://api.test' }))

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  await bootstrapClientCapabilities(false, '')
})

it('accepts a 16-second manifest without cancelling a healthy slow response', async () => {
  vi.useFakeTimers()
  const signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal!
    signals.push(signal)
    const timer = setTimeout(() => resolve(Response.json({ 'accounts:login': true })), 16_000)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })))
  const result = vi.fn()
  const boot = bootstrapClientCapabilities(true, '', true)
  void boot.then(result, result)
  await vi.advanceTimersByTimeAsync(16_000)
  expect(result).toHaveBeenCalledWith(expect.objectContaining({ 'accounts:login': true }))
  await boot
  expect(signals).toHaveLength(3)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

function upload(signal: AbortSignal) {
  return transferMedia(new ArrayBuffer(8), 'image/png', 'hash', {
    signal,
    current: () => signal.throwIfAborted(),
  })
}

it('bounds a stalled manifest body even when the transport ignores abort', async () => {
  vi.useFakeTimers()
  const signals: AbortSignal[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    signals.push(init.signal!)
    return new Response(new ReadableStream())
  }))
  const outcome = expect(bootstrapClientCapabilities(true, '', true)).rejects.toThrow('capability_request_timeout')
  await vi.advanceTimersByTimeAsync(30_000)
  await outcome
  expect(signals).toHaveLength(3)
  expect(signals.every((signal) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not let late manifests overwrite the first completed response', async () => {
  vi.useFakeTimers()
  let late!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn()
    .mockReturnValueOnce(new Promise<Response>((resolve) => { late = resolve }))
    .mockResolvedValueOnce(Response.json({ 'accounts:login': false })))
  const boot = bootstrapClientCapabilities(true, '', true)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await boot).toMatchObject({ 'accounts:login': false })
  late(Response.json({ 'accounts:login': true }))
  await vi.advanceTimersByTimeAsync(30_000)
  expect(getClientCapabilityManifest()['accounts:login']).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('retries prompt transport failures without waiting for fallback timers', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn()
    .mockRejectedValueOnce(new TypeError('failed to fetch'))
    .mockResolvedValueOnce(Response.json({ 'accounts:login': true })))
  await expect(bootstrapClientCapabilities(true, '', true)).resolves.toMatchObject({ 'accounts:login': true })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('retries a transport-aborted response body while the caller remains active', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) {
      controller.error(new DOMException('transport interrupted', 'AbortError'))
    } })))
    .mockResolvedValueOnce(Response.json({ id: 'ready', status: 'ready' }))
  vi.stubGlobal('fetch', fetchMock)
  const pending = upload(new AbortController().signal)
  const outcome = expect(pending).resolves.toMatchObject({ id: 'ready', status: 'ready' })
  await vi.advanceTimersByTimeAsync(500)
  await outcome
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('does not retry when the caller cancels the interrupted upload', async () => {
  vi.useFakeTimers()
  const caller = new AbortController()
  const fetchMock = vi.fn(async () => {
    caller.abort()
    throw caller.signal.reason
  })
  vi.stubGlobal('fetch', fetchMock)
  await expect(upload(caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('bounds repeated transport aborts to four attempts', async () => {
  vi.useFakeTimers()
  const fetchMock = vi.fn().mockRejectedValue(new DOMException('interrupted', 'AbortError'))
  vi.stubGlobal('fetch', fetchMock)
  const outcome = expect(upload(new AbortController().signal)).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(10_000)
  await outcome
  expect(fetchMock).toHaveBeenCalledTimes(4)
})

it('stops immediately when the caller cancels during abort recovery backoff', async () => {
  vi.useFakeTimers()
  const caller = new AbortController()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('interrupted', 'AbortError')))
  const pending = upload(caller.signal)
  const outcome = expect(pending).rejects.toThrow('user cancelled')
  await vi.advanceTimersByTimeAsync(100)
  caller.abort(new Error('user cancelled'))
  await outcome
  await vi.advanceTimersByTimeAsync(10_000)
  expect(fetch).toHaveBeenCalledTimes(1)
})
