// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kpi } from '../../components/Kpi'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

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
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Kpi animated numeric transitions', () => {
  it('renders initial values immediately and smoothly interpolates numeric updates', () => {
    mockReducedMotion(false)
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    act(() => root.render(<Kpi label="成功数" value="1,000" />))
    expect(host.textContent).toContain('1,000')

    act(() => root.render(<Kpi label="成功数" value="1,200" />))
    expect(frames.length).toBeGreaterThan(0)

    now = 1140
    act(() => frames.shift()?.(now))
    expect(host.textContent).not.toContain('1,000')
    expect(host.textContent).not.toContain('1,200')

    now = 1300
    act(() => frames.shift()?.(now))
    expect(host.textContent).toContain('1,200')
  })

  it('snaps immediately when prefers-reduced-motion is reduce and leaves non-numeric values intact', () => {
    mockReducedMotion(true)
    act(() => root.render(<Kpi label="成功率" value="92.5%" />))
    act(() => root.render(<Kpi label="成功率" value="99.1%" />))
    expect(host.textContent).toContain('99.1%')

    act(() => root.render(<Kpi label="状态" value="—" />))
    expect(host.textContent).toContain('—')
  })
})
