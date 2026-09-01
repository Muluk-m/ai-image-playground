// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdateAvailable } from '../../hooks/useUpdateAvailable'
import type { UpdateChecker } from '../../lib/appUpdate'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const POLL_INTERVAL_MS = 10 * 60 * 1000
const REFOCUS_MIN_GAP_MS = 60 * 1000

let host: HTMLDivElement
let root: Root

function Probe({ checker }: { checker: UpdateChecker }) {
  const { availableVersion, skip } = useUpdateAvailable(checker)
  return (
    <button type="button" data-testid="skip" onClick={skip}>
      {availableVersion ?? ''}
    </button>
  )
}

function probe(): HTMLButtonElement {
  const el = host.querySelector<HTMLButtonElement>('[data-testid="skip"]')
  if (!el) throw new Error('probe not rendered')
  return el
}

/** 让 effect 里已 resolve 的 checker promise 落到 state 上。 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
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
  vi.unstubAllGlobals()
})

describe('useUpdateAvailable', () => {
  it('checks once on mount and again on every poll interval', async () => {
    const checker = vi.fn<UpdateChecker>(async () => null)
    act(() => root.render(<Probe checker={checker} />))
    await settle()
    expect(checker).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(checker).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(checker).toHaveBeenCalledTimes(3)
  })

  it('surfaces the version the checker reports', async () => {
    const checker = vi.fn<UpdateChecker>(async () => 'abc-2')
    act(() => root.render(<Probe checker={checker} />))
    await settle()
    expect(probe().textContent).toBe('abc-2')
  })

  it('re-checks when the window becomes visible again, debounced', async () => {
    const checker = vi.fn<UpdateChecker>(async () => null)
    act(() => root.render(<Probe checker={checker} />))
    await settle()
    expect(checker).toHaveBeenCalledTimes(1)

    // 刚查过，重新聚焦不重复拉。
    await act(async () => {
      setVisibility('hidden')
      setVisibility('visible')
    })
    expect(checker).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFOCUS_MIN_GAP_MS)
      setVisibility('visible')
    })
    expect(checker).toHaveBeenCalledTimes(2)
  })

  it('stops polling after unmount', async () => {
    const checker = vi.fn<UpdateChecker>(async () => null)
    act(() => root.render(<Probe checker={checker} />))
    await settle()
    act(() => root.unmount())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(checker).toHaveBeenCalledTimes(1)

    root = createRoot(host)
  })

  it('persists the skipped version and hides the prompt', async () => {
    const setItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: () => {} })
    const checker = vi.fn<UpdateChecker>(async () => 'abc-2')
    act(() => root.render(<Probe checker={checker} />))
    await settle()

    await act(async () => {
      probe().click()
    })
    expect(setItem).toHaveBeenCalledWith('update-skipped-version', 'abc-2')
    expect(probe().textContent).toBe('')
  })
})
