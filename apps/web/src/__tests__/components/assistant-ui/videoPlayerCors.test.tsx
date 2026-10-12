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
