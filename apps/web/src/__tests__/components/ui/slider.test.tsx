// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Slider } from '../../../components/ui/slider'
import { stubPointerApis } from '../../helpers/radix'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('exposes a named vertical slider and applies keyboard changes within its limits', () => {
  stubPointerApis()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const onChange = vi.fn()
  try {
    act(() =>
      root.render(
        <Slider
          orientation="vertical"
          defaultValue={[64]}
          min={8}
          max={220}
          aria-label="笔刷大小"
          onValueChange={onChange}
        />,
      ),
    )
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!
    expect(slider.getAttribute('aria-label')).toBe('笔刷大小')
    expect(slider.getAttribute('aria-orientation')).toBe('vertical')
    const key = (value: string) =>
      act(() => {
        slider.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }))
      })
    key('ArrowUp')
    expect(onChange).toHaveBeenLastCalledWith([65])
    key('Home')
    expect(onChange).toHaveBeenLastCalledWith([8])
    key('ArrowDown')
    expect(slider.getAttribute('aria-valuenow')).toBe('8')
    key('End')
    expect(onChange).toHaveBeenLastCalledWith([220])
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
