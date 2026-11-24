// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSlidingIndicator } from '../../hooks/useSlidingIndicator'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function TabsHarness({ active, open = true }: { active: 'a' | 'b' | null; open?: boolean }) {
  const { containerRef, indicatorStyle, visible } = useSlidingIndicator(open ? active : null)
  if (!open) return null
  return (
    <div ref={containerRef} data-visible={String(visible)}>
      {visible && <span data-indicator style={indicatorStyle} />}
      <button type="button" aria-pressed={active === 'a'}>
        A
      </button>
      <button type="button" aria-pressed={active === 'b'}>
        B
      </button>
    </div>
  )
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('useSlidingIndicator', () => {
  it('stays hidden as a clean fallback when layout metrics are zero', () => {
    act(() => root.render(<TabsHarness active="a" />))
    expect(host.querySelector('[data-indicator]')).toBeNull()
    expect(host.querySelector('[data-visible]')?.getAttribute('data-visible')).toBe('false')
  })

  it('positions immediately on first layout measurement and animates subsequent switches', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    act(() => root.render(<TabsHarness active="a" />))
    const [btnA, btnB] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnA!, {
      offsetLeft: { configurable: true, value: 4 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 60 },
      offsetHeight: { configurable: true, value: 28 },
    })
    Object.defineProperties(btnB!, {
      offsetLeft: { configurable: true, value: 68 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 72 },
      offsetHeight: { configurable: true, value: 28 },
    })

    // First valid measurement snaps without flying in from (0, 0).
    act(() => root.render(<TabsHarness active="b" />))
    const indicator = host.querySelector<HTMLElement>('[data-indicator]')!
    expect(indicator).not.toBeNull()
    expect(indicator.style.transform).toBe('translate3d(68px, 2px, 0)')
    expect(indicator.style.width).toBe('72px')
    expect(indicator.style.transition).toBe('none')

    // After first paint frame, subsequent switches smoothly animate.
    act(() => frames.shift()?.(16))
    act(() => root.render(<TabsHarness active="a" />))
    expect(indicator.style.transform).toBe('translate3d(4px, 2px, 0)')
    expect(indicator.style.width).toBe('60px')
    expect(indicator.style.transition).toContain('var(--motion-normal)')
  })

  it('still enables transitions after StrictMode effect replay cancels the first rAF', () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextId = 1
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextId++
      frames.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames.delete(id)
    })

    act(() =>
      root.render(
        <StrictMode>
          <TabsHarness active="a" />
        </StrictMode>,
      ),
    )
    const [btnA, btnB] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnA!, {
      offsetLeft: { configurable: true, value: 4 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 60 },
      offsetHeight: { configurable: true, value: 28 },
    })
    Object.defineProperties(btnB!, {
      offsetLeft: { configurable: true, value: 68 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 72 },
      offsetHeight: { configurable: true, value: 28 },
    })

    act(() =>
      root.render(
        <StrictMode>
          <TabsHarness active="b" />
        </StrictMode>,
      ),
    )
    expect(frames.size).toBe(1)
    const pending = [...frames.values()][0]
    act(() => pending?.(16))

    const indicator = host.querySelector<HTMLElement>('[data-indicator]')!
    expect(indicator.style.transition).toContain('var(--motion-normal)')
  })

  it('resets transition state when container unmounts and remounts so indicator snaps cleanly', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    act(() => root.render(<TabsHarness active="a" open={true} />))
    const [btnA1] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnA1!, {
      offsetLeft: { configurable: true, value: 4 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 60 },
      offsetHeight: { configurable: true, value: 28 },
    })
    act(() => root.render(<TabsHarness active="a" open={true} />))
    // Switch to trigger measurement with layout metrics, then enable transitions.
    const [, btnB1] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnB1!, {
      offsetLeft: { configurable: true, value: 68 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 72 },
      offsetHeight: { configurable: true, value: 28 },
    })
    act(() => root.render(<TabsHarness active="b" open={true} />))
    act(() => frames.shift()?.(16))
    expect(host.querySelector<HTMLElement>('[data-indicator]')?.style.transition).toContain(
      'var(--motion-normal)',
    )

    // Close popover / unmount container.
    act(() => root.render(<TabsHarness active="b" open={false} />))
    expect(host.querySelector('[data-indicator]')).toBeNull()

    // Reopen container: must snap on first paint without flying from old coordinates.
    act(() => root.render(<TabsHarness active="a" open={true} />))
    const [btnA2] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnA2!, {
      offsetLeft: { configurable: true, value: 4 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 60 },
      offsetHeight: { configurable: true, value: 28 },
    })
    // Trigger re-measure via activeKey change after metrics exist.
    act(() => root.render(<TabsHarness active="b" open={true} />))
    const [, btnB2] = [...host.querySelectorAll('button')]
    Object.defineProperties(btnB2!, {
      offsetLeft: { configurable: true, value: 68 },
      offsetTop: { configurable: true, value: 2 },
      offsetWidth: { configurable: true, value: 72 },
      offsetHeight: { configurable: true, value: 28 },
    })
    act(() => root.render(<TabsHarness active="a" open={true} />))
    const remounted = host.querySelector<HTMLElement>('[data-indicator]')!
    expect(remounted.style.transition).toBe('none')
    expect(remounted.style.transform).toBe('translate3d(4px, 2px, 0)')
  })
})
