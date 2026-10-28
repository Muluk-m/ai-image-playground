// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import HomeTargetPicker from '../../components/creation/HomeTargetPicker'
import { useStore } from '../../store'

vi.mock('../../lib/clientCapabilities', async (original) => ({
  ...(await original<typeof import('../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: () => true,
}))
vi.mock('../../lib/channels/videoChannels', async (original) => ({
  ...(await original<typeof import('../../lib/channels/videoChannels')>()),
  isVideoModeAvailable: () => true,
}))

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

it('lists every creation route in one picker and keeps the shared draft when switching', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  const previous = useStore.getState()
  const references = [{ id: 'kept', dataUrl: 'data:image/png;base64,AA' }]
  useStore.setState({ createTarget: 'video', prompt: 'keep this idea', inputImages: references })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<HomeTargetPicker />))
    const trigger = () => host.querySelector<HTMLElement>('[role="combobox"]')!
    expect(trigger().getAttribute('aria-label')).toBe('选择创作方式')
    expect(trigger().textContent).toContain('视频生成')
    for (const target of ['canvas', 'chat', 'generate'] as const) {
      press(trigger(), 'Enter')
      const options = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      expect(options.map((option) => option.textContent)).toEqual([
        '智能创作',
        '图片生成',
        '视频生成',
        '画布创作',
      ])
      const label = { canvas: '画布创作', chat: '智能创作', generate: '图片生成' }[target]
      const option = options.find((one) => one.textContent === label)!
      act(() => option.focus())
      press(option, 'Enter')
      expect(useStore.getState().createTarget).toBe(target)
      expect(useStore.getState().prompt).toBe('keep this idea')
      expect(useStore.getState().inputImages).toBe(references)
      expect(trigger().textContent).toContain(label)
    }
  } finally {
    act(() => root.unmount())
    host.remove()
    useStore.setState(previous)
    vi.unstubAllGlobals()
  }
})
