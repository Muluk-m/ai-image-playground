// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { captureVideoPoster } from '../../../features/agent/lib/videoPoster'

vi.mock('../../../features/video/lib/playback', () => ({
  captureVideoFrame: () => 'data:image/jpeg;base64,frame',
}))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('waits for slow first-frame data beyond the previous eight-second cutoff', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const create = document.createElement.bind(document)
  let video: HTMLVideoElement | undefined
  vi.spyOn(document, 'createElement').mockImplementation((name: string) => {
    const element = create(name)
    if (name === 'video') video = element as HTMLVideoElement
    return element
  })
  const promise = captureVideoPoster('https://example.test/slow-first-frame')
  expect(video?.preload).toBe('auto')
  await vi.advanceTimersByTimeAsync(10_300)
  video!.dispatchEvent(new Event('loadeddata'))
  await expect(promise).resolves.toBe('data:image/jpeg;base64,frame')
})
it('gives up on a first frame that never arrives', async () => {
  vi.useFakeTimers()
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const pending = captureVideoPoster('https://example.test/never')
  await vi.advanceTimersByTimeAsync(30_000)
  await expect(pending).resolves.toBeNull()
})
