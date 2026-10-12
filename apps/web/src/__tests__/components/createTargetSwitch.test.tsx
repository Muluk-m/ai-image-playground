// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import CreateTargetSwitch from '../../components/CreateTargetSwitch'
import { useStore } from '../../store'

vi.mock('../../lib/clientCapabilities', async (original) => ({
  ...(await original<typeof import('../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: () => true,
}))
it('retains all three creation routes and shared draft when switching out of video', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const previous = useStore.getState()
  const references = [{ id: 'kept', dataUrl: 'data:image/png;base64,AA' }]
  useStore.setState({ createTarget: 'video', prompt: 'keep this idea', inputImages: references })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<CreateTargetSwitch />))
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.map((tab) => tab.textContent)).toEqual(['智能创作', '快速生成', '画布创作'])
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true')
    for (const [index, target] of [
      [2, 'canvas'],
      [0, 'chat'],
      [1, 'generate'],
    ] as const) {
      act(() => tabs[index]!.click())
      expect(useStore.getState().createTarget).toBe(target)
      expect(useStore.getState().prompt).toBe('keep this idea')
      expect(useStore.getState().inputImages).toBe(references)
    }
  } finally {
    act(() => root.unmount())
    useStore.setState(previous)
    vi.unstubAllGlobals()
  }
})
