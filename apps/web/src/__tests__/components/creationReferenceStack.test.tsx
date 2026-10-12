// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CreationReferenceStack } from '../../components/creation/CreationReferenceStack'
import { Button } from '../../components/ui/button'
import { pointer, stubPointerApis } from '../helpers/radix'

it('keeps bulk references behind one stack and preserves individual removal and adding', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  const add = vi.fn()
  function Fixture() {
    const [count, setCount] = useState(100)
    return (
      <CreationReferenceStack
        count={count}
        previews={[<span key="a">A</span>, <span key="b">B</span>, <span key="c">C</span>]}
        add={<Button onClick={add}>添加</Button>}
      >
        <Button onClick={() => setCount(count - 1)}>移除一张</Button>
      </CreationReferenceStack>
    )
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<Fixture />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    act(() => host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('移除一张')
    act(() => dialog.querySelector<HTMLButtonElement>('button')!.click())
    expect(host.querySelector('.creation-stack-trigger')!.getAttribute('aria-label')).toContain(
      '99',
    )
    act(() => host.querySelector<HTMLButtonElement>('.creation-stack-add button')!.click())
    expect(add).toHaveBeenCalledOnce()
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('opens on mouse hover without stealing focus, bridges the gap, and keeps clicks available', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  stubPointerApis()
  vi.useFakeTimers()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <>
          <input aria-label="prompt" />
          <CreationReferenceStack count={8} previews={[]} add={<Button>添加</Button>}>
            <Button>一张参考图</Button>
          </CreationReferenceStack>
        </>,
      ),
    )
    const prompt = host.querySelector('input')!
    prompt.focus()
    const trigger = host.querySelector<HTMLButtonElement>('.creation-stack-trigger')!
    act(() => trigger.dispatchEvent(pointer('pointerover')))
    const panel = document.querySelector<HTMLElement>('.creation-reference-panel')!
    expect(panel).not.toBeNull()
    expect(document.activeElement).toBe(prompt)
    act(() => trigger.dispatchEvent(pointer('pointerout')))
    act(() => vi.advanceTimersByTime(100))
    act(() => panel.dispatchEvent(pointer('pointerover')))
    act(() => vi.advanceTimersByTime(300))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    act(() => panel.dispatchEvent(pointer('pointerout')))
    act(() => vi.advanceTimersByTime(300))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(prompt)
    act(() => trigger.dispatchEvent(pointer('pointerover')))
    act(() => trigger.click())
    act(() => trigger.dispatchEvent(pointer('pointerout')))
    act(() => vi.advanceTimersByTime(300))
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    const touch = new MouseEvent('pointerover', { bubbles: true })
    Object.defineProperty(touch, 'pointerType', { value: 'touch' })
    act(() => trigger.dispatchEvent(touch))
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    act(() => trigger.click())
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  } finally {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
