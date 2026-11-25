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

function GridHarness({ items }: { items: string[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useFlipList(ref, '[data-flip-id]', 'data-flip-id', items.join(','))
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

  it('skips FLIP animations under prefers-reduced-motion: reduce', () => {
    mockReducedMotion(true)
    const animate = vi.fn()
    Element.prototype.animate = animate

    act(() => root.render(<GridHarness items={['a', 'b']} />))
    setRect(host.querySelector<HTMLElement>('[data-flip-id="a"]')!, 0, 0)
    setRect(host.querySelector<HTMLElement>('[data-flip-id="b"]')!, 140, 0)
    act(() => root.render(<GridHarness items={['a', 'b', 'c']} />))

    setRect(host.querySelector<HTMLElement>('[data-flip-id="a"]')!, 140, 0)
    act(() => root.render(<GridHarness items={['new', 'a', 'b']} />))

    expect(animate).not.toHaveBeenCalled()
  })
})
