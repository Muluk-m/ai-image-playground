// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOADING_MARK_HOLD_MS, useHeldLoading } from '../../hooks/useHeldLoading'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function Probe({ active }: { active: boolean }) {
  const held = useHeldLoading(active)
  return <span>{held ? 'shown' : 'hidden'}</span>
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('holding a loading mark', () => {
  it('stays hidden while nothing is loading', () => {
    act(() => root.render(<Probe active={false} />))
    expect(host.textContent).toBe('hidden')
  })

  it('stays hidden until the wait has lasted the hold', () => {
    act(() => root.render(<Probe active={true} />))
    expect(host.textContent).toBe('hidden')

    act(() => {
      vi.advanceTimersByTime(LOADING_MARK_HOLD_MS - 1)
    })
    expect(host.textContent).toBe('hidden')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(host.textContent).toBe('shown')
  })

  it('never shows when the wait ends during the hold', () => {
    act(() => root.render(<Probe active={true} />))
    act(() => {
      vi.advanceTimersByTime(LOADING_MARK_HOLD_MS - 1)
    })
    act(() => root.render(<Probe active={false} />))
    act(() => {
      vi.advanceTimersByTime(LOADING_MARK_HOLD_MS)
    })
    expect(host.textContent).toBe('hidden')
  })

  it('hides again as soon as the wait ends', () => {
    act(() => root.render(<Probe active={true} />))
    act(() => {
      vi.advanceTimersByTime(LOADING_MARK_HOLD_MS)
    })
    expect(host.textContent).toBe('shown')

    act(() => root.render(<Probe active={false} />))
    expect(host.textContent).toBe('hidden')
  })
})
