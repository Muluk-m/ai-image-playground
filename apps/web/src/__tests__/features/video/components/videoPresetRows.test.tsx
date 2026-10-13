// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import VideoPresetRows from '../../../../features/video/components/VideoPresetRows'
import { useVideoStore } from '../../../../features/video/store'
import { pointer, stubPointerApis } from '../../../helpers/radix'

it('keeps uncommon saved durations selectable without expanding every duration into a button', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  const previous = useVideoStore.getState().draft
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const model = 'grok-imagine-video-1.5-lite'
  function Fixture() {
    const draft = useVideoStore((state) => state.draft)
    return (
      <VideoPresetRows
        support={VIDEO_MODEL_SUPPORT[model]!}
        draft={draft}
        aspectFollowsFirstFrame={false}
      />
    )
  }
  try {
    useVideoStore.setState({ draft: { ...previous, model, duration: 3 } })
    act(() => root.render(<Fixture />))
    const group = host.querySelector('[role="group"][aria-label="时长"]')!
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      '5 秒',
      '8 秒',
      '10 秒',
      '15 秒',
    ])
    const more = host.querySelector<HTMLButtonElement>('[aria-label="其他时长"]')!
    expect(more.textContent).toContain('3 秒')
    act(() => more.dispatchEvent(pointer('pointerdown')))
    const six = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === '6 秒',
    )!
    expect(six).toBeDefined()
    act(() => {
      six.dispatchEvent(pointer('pointermove'))
      six.dispatchEvent(pointer('pointerup'))
    })
    expect(useVideoStore.getState().draft.duration).toBe(6)
    act(() => group.querySelector<HTMLButtonElement>('button')!.click())
    expect(useVideoStore.getState().draft.duration).toBe(5)
    expect(more.textContent).toContain('其他时长')
  } finally {
    act(() => root.unmount())
    useVideoStore.setState({ draft: previous })
    host.remove()
    vi.unstubAllGlobals()
  }
})
