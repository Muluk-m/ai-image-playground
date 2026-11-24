// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type NumberDirection, useAnimatedNumber } from '../../hooks/useAnimatedNumber'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let latest: { display: number | null; direction: NumberDirection } = {
  display: null,
  direction: null,
}

function Probe({ value, duration = 300 }: { value: number | null; duration?: number }) {
  latest = useAnimatedNumber(value, duration)
  return (
    <span data-direction={latest.direction ?? ''}>
      {latest.display === null ? '—' : latest.display}
    </span>
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

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  latest = { display: null, direction: null }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useAnimatedNumber', () => {
  it('snaps immediately on initial mount and null-to-number arrival without counting from zero', () => {
    mockReducedMotion(false)
    act(() => root.render(<Probe value={null} />))
    expect(latest).toEqual({ display: null, direction: null })

    act(() => root.render(<Probe value={500} />))
    expect(latest).toEqual({ display: 500, direction: null })
  })

  it('interpolates subsequent updates smoothly and clears direction after settling', () => {
    mockReducedMotion(false)
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    act(() => root.render(<Probe value={100} duration={300} />))
    expect(latest.display).toBe(100)

    act(() => root.render(<Probe value={200} duration={300} />))
    expect(latest.direction).toBe('up')
    expect(frames.length).toBeGreaterThan(0)

    now = 1150
    act(() => frames.shift()?.(now))
    expect(latest.display).toBeGreaterThan(100)
    expect(latest.display).toBeLessThan(200)

    now = 1320
    act(() => frames.shift()?.(now))
    expect(latest.display).toBe(200)

    act(() => vi.advanceTimersByTime(500))
    expect(latest.direction).toBeNull()
  })

  it('snaps immediately when prefers-reduced-motion is reduce', () => {
    mockReducedMotion(true)
    act(() => root.render(<Probe value={100} />))
    act(() => root.render(<Probe value={80} />))
    expect(latest.display).toBe(80)
    expect(latest.direction).toBe('down')
  })

  it('clears direction when a new target matches the current interpolated value', () => {
    mockReducedMotion(false)
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    act(() => root.render(<Probe value={100} duration={300} />))
    act(() => root.render(<Probe value={200} duration={300} />))
    now = 1150
    act(() => frames.shift()?.(now))
    const midValue = latest.display!
    expect(latest.direction).toBe('up')

    // Target changes mid-flight to match the currently displayed value.
    act(() => root.render(<Probe value={midValue} duration={300} />))
    expect(latest.display).toBe(midValue)
    expect(latest.direction).toBeNull()
  })
})
