// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { VideoPlayer } from '../../../components/assistant-ui/elements/video-player'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('keeps authenticated media credentialed while allowing public non-CORS playback', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const host = document.createElement('div')
  const root = createRoot(host)
  const labels = {
    label: 'Video',
    errorLabel: 'Error',
    retryLabel: 'Retry',
    loadingLabel: 'Loading',
  }
  try {
    act(() => root.render(<VideoPlayer src="/private.mp4" {...labels} />))
    expect(host.querySelector('video')?.getAttribute('crossorigin')).toBe('use-credentials')
    act(() =>
      root.render(
        <VideoPlayer src="https://media.example/public.mp4" crossOrigin={null} {...labels} />,
      ),
    )
    expect(host.querySelector('video')?.hasAttribute('crossorigin')).toBe(false)
  } finally {
    act(() => root.unmount())
    vi.restoreAllMocks()
  }
})

it('captures a decoded playing frame without pausing early playback', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const host = document.createElement('div')
  const root = createRoot(host)
  const capture = vi.fn()
  try {
    act(() =>
      root.render(
        <VideoPlayer
          src="/clip.mp4"
          label="Video"
          errorLabel="Error"
          retryLabel="Retry"
          loadingLabel="Loading"
          onFrameReady={capture}
        />,
      ),
    )
    const video = host.querySelector('video')!
    Object.defineProperty(video, 'paused', { value: false })
    act(() => video.dispatchEvent(new Event('loadeddata')))
    expect(capture).not.toHaveBeenCalled()
    act(() => video.dispatchEvent(new Event('playing')))
    expect(capture).toHaveBeenCalledWith(video)
    act(() => video.dispatchEvent(new Event('playing')))
    expect(capture).toHaveBeenCalledTimes(1)
  } finally {
    act(() => root.unmount())
    vi.restoreAllMocks()
  }
})

it('retries a poster seek interrupted by a media error', () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  const host = document.createElement('div')
  const root = createRoot(host)
  const capture = vi.fn()
  try {
    act(() =>
      root.render(
        <VideoPlayer
          src="/clip.mp4"
          label="Video"
          errorLabel="Error"
          retryLabel="Retry"
          loadingLabel="Loading"
          onFrameReady={capture}
        />,
      ),
    )
    const video = host.querySelector('video')!
    act(() => video.dispatchEvent(new Event('loadeddata')))
    expect(video.currentTime).toBe(0.1)
    act(() => video.dispatchEvent(new Event('error')))
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    const retried = host.querySelector('video')!
    retried.currentTime = 0
    act(() => retried.dispatchEvent(new Event('loadeddata')))
    expect(retried.currentTime).toBe(0.1)
    act(() => retried.dispatchEvent(new Event('seeked')))
    expect(capture).toHaveBeenCalledWith(retried)
  } finally {
    act(() => root.unmount())
    vi.restoreAllMocks()
  }
})
