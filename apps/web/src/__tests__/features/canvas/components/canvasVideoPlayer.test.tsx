// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import CanvasVideoPlayer from '../../../../features/canvas/components/CanvasVideoPlayer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('keeps its source through a StrictMode remount and releases the stream on unmount', () => {
  const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() =>
    root.render(
      <StrictMode>
        <CanvasVideoPlayer src="/clip.mp4" onEnded={() => {}} />
      </StrictMode>,
    ),
  )
  const video = host.querySelector('video')!
  expect(video.getAttribute('src')).toBe('/clip.mp4')
  act(() => root.unmount())
  expect(pause).toHaveBeenCalled()
  expect(load).toHaveBeenCalled()
  expect(video.getAttribute('src')).toBeNull()
  vi.restoreAllMocks()
})
