// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSwipeDismiss } from '../../hooks/useSwipeDismiss'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function DrawerHarness({ onDismiss }: { onDismiss: () => void }) {
  const { offsetX, dragging, handlers } = useSwipeDismiss(onDismiss)
  return (
    <aside data-drawer data-offset={offsetX} data-dragging={String(dragging)} {...handlers}>
      drawer
    </aside>
  )
}

function fireTouch(target: Element, type: string, x: number, y: number) {
  const touches =
    type === 'touchend' || type === 'touchcancel'
      ? []
      : ([{ clientX: x, clientY: y, target }] as unknown as Touch[])
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches,
    targetTouches: touches,
    changedTouches: [{ clientX: x, clientY: y, target }] as unknown as Touch[],
  })
  act(() => {
    target.dispatchEvent(event)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('useSwipeDismiss', () => {
  it('follows horizontal right drag 1:1 and dismisses past threshold', () => {
    const onDismiss = vi.fn()
    act(() => root.render(<DrawerHarness onDismiss={onDismiss} />))
    const drawer = host.querySelector<HTMLElement>('[data-drawer]')!

    fireTouch(drawer, 'touchstart', 20, 100)
    fireTouch(drawer, 'touchmove', 80, 104)
    expect(drawer.dataset.dragging).toBe('true')
    expect(Number(drawer.dataset.offset)).toBe(60)

    fireTouch(drawer, 'touchmove', 150, 106)
    fireTouch(drawer, 'touchend', 150, 106)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores vertical scroll gestures and springs back on short horizontal pull', () => {
    const onDismiss = vi.fn()
    act(() => root.render(<DrawerHarness onDismiss={onDismiss} />))
    const drawer = host.querySelector<HTMLElement>('[data-drawer]')!

    // Vertical scroll must not lock horizontal dismiss.
    fireTouch(drawer, 'touchstart', 100, 100)
    fireTouch(drawer, 'touchmove', 104, 180)
    expect(drawer.dataset.dragging).toBe('false')
    fireTouch(drawer, 'touchend', 104, 180)
    expect(onDismiss).not.toHaveBeenCalled()

    // Short slow pull springs back instead of dismissing.
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(500)
    fireTouch(drawer, 'touchstart', 20, 100)
    fireTouch(drawer, 'touchmove', 55, 102)
    expect(drawer.dataset.dragging).toBe('true')
    fireTouch(drawer, 'touchend', 55, 102)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(drawer.dataset.offset).toBe('0')
  })
})
