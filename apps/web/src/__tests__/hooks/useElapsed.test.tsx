// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatElapsed, useElapsed } from '../../hooks/useElapsed'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('formatting an elapsed span', () => {
  it('reads seconds below a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(12_400)).toBe('12s')
  })

  it('reads minutes and seconds from a minute on', () => {
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(3_725_000)).toBe('62:05')
  })

  it('never reads negative', () => {
    expect(formatElapsed(-5_000)).toBe('0s')
  })
})

let host: HTMLDivElement
let root: Root

function Probe({ startedAt }: { startedAt: number | null }) {
  const elapsed = useElapsed(startedAt)
  return <span>{elapsed === null ? 'idle' : formatElapsed(elapsed)}</span>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-04T00:00:00Z'))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('reading the clock while something runs', () => {
  it('stays idle without a start time', () => {
    act(() => root.render(<Probe startedAt={null} />))

    expect(host.textContent).toBe('idle')
  })

  it('counts up once a second from the start time', () => {
    act(() => root.render(<Probe startedAt={Date.now() - 3_000} />))
    expect(host.textContent).toBe('3s')

    act(() => {
      vi.advanceTimersByTime(2_000)
    })

    expect(host.textContent).toBe('5s')
  })

  it('stops ticking when the start time is cleared', () => {
    act(() => root.render(<Probe startedAt={Date.now()} />))
    act(() => root.render(<Probe startedAt={null} />))

    act(() => {
      vi.advanceTimersByTime(5_000)
    })

    expect(host.textContent).toBe('idle')
  })
})
