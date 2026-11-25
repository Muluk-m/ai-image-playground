// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFlipList } from '../../hooks/useFlipList'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let originalAnimate: typeof Element.prototype.animate | undefined

function GridHarness({
  items,
  orderKey,
  snapshotKey,
}: {
  items: string[]
  orderKey?: string
  snapshotKey?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFlipList(ref, '[data-flip-id]', 'data-flip-id', orderKey ?? items.join(','), snapshotKey)
  return (
    <div ref={ref} data-grid>
      {items.map((id) => (
        <div key={id} data-flip-id={id}>
          {id}
        </div>
      ))}
    </div>
  )
}

function mockReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

function setRect(el: HTMLElement, left: number, top: number) {
  el.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + 120,
      bottom: top + 120,
      width: 120,
      height: 120,
      x: left,
      y: top,
      toJSON: () => {},
    }) as DOMRect
}

beforeEach(() => {
  originalAnimate = Element.prototype.animate
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  mockReducedMotion(false)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  if (originalAnimate === undefined) {
    // @ts-expect-error restore jsdom default where Element.prototype.animate is undefined
    delete Element.prototype.animate
  } else {
    Element.prototype.animate = originalAnimate
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useFlipList', () => {
  it('animates surviving cards from previous coordinates when a new card is inserted', () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation)
    Element.prototype.animate = animate

    act(() => root.render(<GridHarness items={['a', 'b']} />))
    const a = host.querySelector<HTMLElement>('[data-flip-id="a"]')!
    const b = host.querySelector<HTMLElement>('[data-flip-id="b"]')!
    setRect(a, 0, 0)
    setRect(b, 140, 0)

    // Record baseline positions once layout metrics exist.
    act(() => root.render(<GridHarness items={['a', 'b', 'c']} />))
    const c = host.querySelector<HTMLElement>('[data-flip-id="c"]')!
    setRect(c, 280, 0)
    animate.mockClear()

    // Prepend 'new' so 'a' shifts right by +140px.
    setRect(a, 140, 0)
    setRect(b, 280, 0)
    act(() => root.render(<GridHarness items={['new', 'a', 'b', 'c']} />))

    expect(animate).toHaveBeenCalled()
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate3d(-140px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      expect.objectContaining({ duration: 240 }),
    )
  })

  it('continues smoothly from previous layout plus remaining animation offset when reflowing mid-flight', () => {
    let runningOffsetX = 0
    const cancel = vi.fn(() => {
      runningOffsetX = 0
    })
    const animate = vi.fn(() => ({ cancel, playState: 'running' }) as unknown as Animation)
    Element.prototype.animate = animate

    act(() => root.render(<GridHarness items={['a']} />))
    const a = host.querySelector<HTMLElement>('[data-flip-id="a"]')!
    let layoutLeft = 100
    a.getBoundingClientRect = () =>
      ({
        left: layoutLeft + runningOffsetX,
        top: 0,
        right: layoutLeft + runningOffsetX + 120,
        bottom: 120,
        width: 120,
        height: 120,
        x: layoutLeft + runningOffsetX,
        y: 0,
        toJSON: () => {},
      }) as DOMRect

    // Record initial baseline at 100.
    act(() => root.render(<GridHarness items={['a', 'b']} />))
    animate.mockClear()

    // First reflow: 100 -> 200 (starts running animation).
    layoutLeft = 200
    act(() => root.render(<GridHarness items={['p1', 'a', 'b']} />))
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate3d(-100px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      expect.objectContaining({ duration: 240 }),
    )

    // Mid-flight at remaining offset -50 (visually at 150), second reflow moves layout to 300.
    // Expected delta = 150 - 300 = -150px (NOT 250 - 300 = -50px).
    animate.mockClear()
    runningOffsetX = -50
    layoutLeft = 300
    act(() => root.render(<GridHarness items={['p2', 'p1', 'a', 'b']} />))
    expect(cancel).toHaveBeenCalled()
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate3d(-150px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      expect.objectContaining({ duration: 240 }),
    )
  })

  it('skips FLIP animations and layout reads under prefers-reduced-motion: reduce', () => {
    mockReducedMotion(true)
    const animate = vi.fn()
    Element.prototype.animate = animate

    act(() => root.render(<GridHarness items={['a', 'b']} />))
    const a = host.querySelector<HTMLElement>('[data-flip-id="a"]')!
    const rectSpy = vi.spyOn(a, 'getBoundingClientRect')
    act(() => root.render(<GridHarness items={['new', 'a', 'b']} />))

    expect(animate).not.toHaveBeenCalled()
    expect(rectSpy).not.toHaveBeenCalled()
  })

  it('refreshes snapshots on snapshotKey changes without animating, then animates on next reorder', () => {
    const cancel = vi.fn()
    const animate = vi.fn(() => ({ cancel }) as unknown as Animation)
    Element.prototype.animate = animate

    // Initial virtual window shows items v1, v2.
    act(() =>
      root.render(<GridHarness items={['v1', 'v2']} orderKey="full-1" snapshotKey="win-1" />),
    )
    setRect(host.querySelector<HTMLElement>('[data-flip-id="v1"]')!, 0, 0)
    setRect(host.querySelector<HTMLElement>('[data-flip-id="v2"]')!, 140, 0)

    // Scroll shifts virtual window to v10, v11 while full orderKey stays identical.
    act(() =>
      root.render(<GridHarness items={['v10', 'v11']} orderKey="full-1" snapshotKey="win-2" />),
    )
    const v10 = host.querySelector<HTMLElement>('[data-flip-id="v10"]')!
    const v11 = host.querySelector<HTMLElement>('[data-flip-id="v11"]')!
    setRect(v10, 0, 100)
    setRect(v11, 140, 100)
    // Snapshot once layout rects are assigned (simulates virtualizer measuring scrolled window).
    act(() =>
      root.render(<GridHarness items={['v10', 'v11']} orderKey="full-1" snapshotKey="win-2b" />),
    )
    expect(animate).not.toHaveBeenCalled()

    // Now delete v10 -> orderKey changes and v11 shifts left from 140 to 0.
    setRect(v11, 0, 100)
    act(() => root.render(<GridHarness items={['v11']} orderKey="full-2" snapshotKey="win-2b" />))

    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate3d(140px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      expect.objectContaining({ duration: 240 }),
    )
  })

  it('bounds synchronous layout measurements on large non-virtualized grids', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
    Element.prototype.animate = animate
    const items = Array.from({ length: 140 }, (_, i) => `item-${i}`)

    act(() => root.render(<GridHarness items={items} />))
    const spies = items.map((id, i) => {
      const el = host.querySelector<HTMLElement>(`[data-flip-id="${id}"]`)!
      const top = Math.floor(i / 4) * 200
      return vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            left: (i % 4) * 140,
            top,
            right: (i % 4) * 140 + 120,
            bottom: top + 180,
            width: 120,
            height: 180,
            x: (i % 4) * 140,
            y: top,
            toJSON: () => {},
          }) as DOMRect,
      )
    })

    act(() => root.render(<GridHarness items={items.slice(1)} />))
    const measuredCount = spies.filter((spy) => spy.mock.calls.length > 0).length
    expect(measuredCount).toBeLessThan(70)
  })

  it('preserves running animations and true layout baseline when snapshotKey changes mid-flight', () => {
    let runningOffsetX = 0
    const cancel = vi.fn(() => {
      runningOffsetX = 0
    })
    const animate = vi.fn(() => ({ cancel, playState: 'running' }) as unknown as Animation)
    Element.prototype.animate = animate

    act(() => root.render(<GridHarness items={['a', 'b']} orderKey="o1" snapshotKey="s1" />))
    const a = host.querySelector<HTMLElement>('[data-flip-id="a"]')!
    let layoutLeft = 100
    a.getBoundingClientRect = () =>
      ({
        left: layoutLeft + runningOffsetX,
        top: 0,
        right: layoutLeft + runningOffsetX + 120,
        bottom: 120,
        width: 120,
        height: 120,
        x: layoutLeft + runningOffsetX,
        y: 0,
        toJSON: () => {},
      }) as DOMRect
    setRect(host.querySelector<HTMLElement>('[data-flip-id="b"]')!, 240, 0)

    // Snapshot initial positions.
    act(() => root.render(<GridHarness items={['a', 'b']} orderKey="o1" snapshotKey="s1b" />))
    animate.mockClear()

    // Reorder moves 'a' from 100 -> 200 (starts running animation).
    layoutLeft = 200
    act(() => root.render(<GridHarness items={['p', 'a', 'b']} orderKey="o2" snapshotKey="s1b" />))
    expect(animate).toHaveBeenCalledTimes(1)

    // While 'a' is mid-flight (-50px offset -> visually 150), virtualizer scrolls (snapshotKey changes, orderKey unchanged).
    runningOffsetX = -50
    cancel.mockClear()
    animate.mockClear()
    act(() => root.render(<GridHarness items={['p', 'a', 'b']} orderKey="o2" snapshotKey="s2" />))
    expect(cancel).not.toHaveBeenCalled()
    expect(animate).not.toHaveBeenCalled()

    // Subsequent reorder moves 'a' to 300 while still mid-flight (-50px): origin must remain 150 (delta -150px).
    layoutLeft = 300
    act(() =>
      root.render(<GridHarness items={['p2', 'p', 'a', 'b']} orderKey="o3" snapshotKey="s2" />),
    )
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translate3d(-150px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
      expect.objectContaining({ duration: 240 }),
    )
  })

  it('preserves true layout baseline when debounced scroll snapshot fires during a running animation', () => {
    vi.useFakeTimers()
    try {
      let runningOffsetX = 0
      const cancel = vi.fn(() => {
        runningOffsetX = 0
      })
      const animate = vi.fn(() => ({ cancel, playState: 'running' }) as unknown as Animation)
      Element.prototype.animate = animate

      const items = Array.from({ length: 70 }, (_, i) => `item-${i}`)
      act(() => root.render(<GridHarness items={items} />))

      let item0Left = 100
      items.forEach((id, i) => {
        const el = host.querySelector<HTMLElement>(`[data-flip-id="${id}"]`)!
        if (i === 0) {
          el.getBoundingClientRect = () =>
            ({
              left: item0Left + runningOffsetX,
              top: 0,
              right: item0Left + runningOffsetX + 120,
              bottom: 120,
              width: 120,
              height: 120,
              x: item0Left + runningOffsetX,
              y: 0,
              toJSON: () => {},
            }) as DOMRect
        } else {
          setRect(el, (i % 4) * 140, Math.floor(i / 4) * 200)
        }
      })

      // Record baseline at item0Left = 100.
      act(() => root.render(<GridHarness items={[...items, 'tail']} />))
      animate.mockClear()

      // Reorder moves item-0 from 100 -> 200 (starts running animation).
      item0Left = 200
      act(() => root.render(<GridHarness items={['head', ...items, 'tail']} />))
      expect(animate).toHaveBeenCalled()

      // Mid-flight (-50px residual offset), user scrolls and debounced scroll snapshot fires.
      runningOffsetX = -50
      act(() => {
        window.dispatchEvent(new Event('scroll'))
        vi.advanceTimersByTime(150)
      })

      // Animation finishes (no more transform offset), then next reorder moves item-0 from 200 -> 300.
      // Baseline must still be 200 (not 150!), so delta is 200 - 300 = -100px.
      runningOffsetX = 0
      animate.mockImplementation(() => ({ cancel, playState: 'finished' }) as unknown as Animation)
      // Simulate the running animation having completed before next reorder.
      const prevAnim = animate.mock.results[0]?.value as { playState: string } | undefined
      if (prevAnim) prevAnim.playState = 'finished'
      animate.mockClear()
      item0Left = 300
      act(() => root.render(<GridHarness items={['head2', 'head', ...items, 'tail']} />))
      expect(animate).toHaveBeenCalledWith(
        [{ transform: 'translate3d(-100px, 0px, 0)' }, { transform: 'translate3d(0, 0, 0)' }],
        expect.objectContaining({ duration: 240 }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
