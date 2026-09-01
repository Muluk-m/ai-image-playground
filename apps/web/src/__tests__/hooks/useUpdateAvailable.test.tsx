// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUpdateAvailable } from '../../hooks/useUpdateAvailable'
import { checkForUpdate, writeSkippedVersion } from '../../lib/appUpdate'

vi.mock('../../lib/appUpdate', () => ({
  checkForUpdate: vi.fn(async () => null),
  writeSkippedVersion: vi.fn(),
}))

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const POLL_INTERVAL_MS = 10 * 60 * 1000
const REFOCUS_MIN_GAP_MS = 60 * 1000

const check = vi.mocked(checkForUpdate)
const skipped = vi.mocked(writeSkippedVersion)

let host: HTMLDivElement
let root: Root

function Probe() {
  const { availableVersion, skip } = useUpdateAvailable()
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

/** 挂载 + 等 effect 里已 resolve 的 promise 落到 state 上。 */
async function mount() {
  act(() => root.render(<Probe />))
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
  check.mockClear()
  check.mockResolvedValue(null)
  skipped.mockClear()
  setVisibility('visible')
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
  it('checks on mount and again on the poll interval', async () => {
    await mount()
    expect(check).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('surfaces the version the checker reports', async () => {
    check.mockResolvedValue('abc-2')
    await mount()
    expect(probe().textContent).toBe('abc-2')
  })

  it('does not poll a hidden tab', async () => {
    await mount()
    setVisibility('hidden')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('re-checks when the window becomes visible again, debounced', async () => {
    await mount()
    expect(check).toHaveBeenCalledTimes(1)

    // 刚查过，重新聚焦不重复拉。
    await act(async () => {
      setVisibility('hidden')
      setVisibility('visible')
    })
    expect(check).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFOCUS_MIN_GAP_MS)
      setVisibility('hidden')
      setVisibility('visible')
    })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('stops polling after unmount', async () => {
    await mount()
    act(() => root.unmount())
    root = createRoot(host)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(check).toHaveBeenCalledTimes(1)
  })

  it('persists the skipped version and hides the prompt', async () => {
    check.mockResolvedValue('abc-2')
    await mount()

    await act(async () => {
      probe().click()
    })
    expect(skipped).toHaveBeenCalledWith('abc-2')
    expect(probe().textContent).toBe('')
  })
})
