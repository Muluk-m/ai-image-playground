// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { capturedVideoPoster } from '../../../features/agent/lib/videoPoster'

vi.mock('../../../features/video/lib/playback', () => ({
  captureVideoFrame: () => 'data:image/jpeg;base64,frame',
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('waits for slow first-frame data beyond the previous eight-second cutoff and caches success', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const create = document.createElement.bind(document)
  let video: HTMLVideoElement | undefined
  vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
    const element = create(name)
    if (name === 'video') video = element as HTMLVideoElement
    return element
  })
  const promise = capturedVideoPoster('https://example.test/slow-first-frame')
  expect(video?.preload).toBe('auto')
  await vi.advanceTimersByTimeAsync(10_300)
  video!.dispatchEvent(new Event('loadeddata'))
  await expect(promise).resolves.toBe('data:image/jpeg;base64,frame')
  await expect(capturedVideoPoster('https://example.test/slow-first-frame')).resolves.toBe(
    'data:image/jpeg;base64,frame',
  )
})
it('evicts failed extraction so the next request can retry', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const first = capturedVideoPoster('https://example.test/retry')
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(first).resolves.toBeNull()
  const second = capturedVideoPoster('https://example.test/retry')
  expect(second).not.toBe(first)
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(second).resolves.toBeNull()
})
