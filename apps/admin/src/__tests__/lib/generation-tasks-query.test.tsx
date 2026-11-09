import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type GenerationTasksResult, todayWindow } from '../../../contracts'
import { presetWindow } from '../../components/FilterBar'
import { ADMIN_REFRESH_EVENT, useGenerationTasks, useGenerationTasksClock } from '../../lib/queries'

const get = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api-client', () => ({ apiClient: { get } }))

const response: GenerationTasksResult = { window: { from: 0, to: 1 }, tasks: [], nextCursor: null }
let client: QueryClient
let visibility: DocumentVisibilityState
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-09T12:00:00Z'))
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
  get.mockReset().mockResolvedValue(response)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(() => {
  cleanup()
  client.clear()
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mount(initial: { preset: 'today' | '7d' | '30d'; from?: number; to?: number }) {
  return renderHook(
    ({ preset, from, to }) => {
      const clock = useGenerationTasksClock(from === undefined && to === undefined)
      const window =
        from !== undefined && to !== undefined
          ? { from, to }
          : preset === 'today'
            ? todayWindow(clock)
            : presetWindow(preset, clock)
      return useGenerationTasks({ ...window, page: 1, pageSize: 50 })
    },
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
}
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
async function setVisibility(next: DocumentVisibilityState) {
  await act(async () => {
    visibility = next
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
}
async function manualRefresh() {
  await act(async () => {
    const event = new Event(ADMIN_REFRESH_EVENT, { cancelable: true })
    window.dispatchEvent(event)
    await client.invalidateQueries({
      predicate: (query) => !(event.defaultPrevented && query.queryKey[0] === 'generation-tasks'),
    })
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('generation tasks refresh', () => {
  it.each([
    'today',
    '7d',
    '30d',
  ] as const)('advances the dynamic %s window once every thirty seconds', async (preset) => {
    mount({ preset })
    await advance()
    expect(get).toHaveBeenCalledTimes(1)
    const firstUrl = get.mock.calls[0]![0]
    await advance(29_999)
    expect(get).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(get).toHaveBeenCalledTimes(2)
    expect(get.mock.calls[1]![0]).not.toBe(firstUrl)
    await advance(30_000)
    expect(get).toHaveBeenCalledTimes(3)
    await manualRefresh()
    expect(get).toHaveBeenCalledTimes(4)
  })

  it('pauses while hidden, catches up immediately on return and restarts the interval', async () => {
    mount({ preset: 'today' })
    await advance()
    await advance(10_000)
    await setVisibility('hidden')
    await advance(120_000)
    expect(get).toHaveBeenCalledTimes(1)
    await setVisibility('visible')
    expect(get).toHaveBeenCalledTimes(2)
    const url = new URL(get.mock.calls[1]![0], 'https://admin.test')
    expect(Number(url.searchParams.get('to'))).toBe(Date.now())
    await advance(29_999)
    expect(get).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('does not refresh a fixed historical range on timers, focus, visibility or reconnect', async () => {
    mount({ preset: '7d', from: Date.now() - 7 * 86400_000, to: Date.now() - 1 })
    await advance()
    await advance(90_000)
    await setVisibility('hidden')
    await setVisibility('visible')
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledTimes(1)
    await manualRefresh()
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('updates a newly resumed live window immediately after viewing fixed history', async () => {
    const { rerender } = mount({
      preset: 'today',
      from: Date.now() - 86400_000,
      to: Date.now() - 1,
    })
    await advance()
    await advance(3600_000)
    rerender({ preset: 'today' })
    await advance()
    expect(get).toHaveBeenCalledTimes(2)
    const url = new URL(get.mock.calls[1]![0], 'https://admin.test')
    expect(Number(url.searchParams.get('to'))).toBe(Date.now())
  })

  it('cleans up the clock timer and event listeners when unmounted', async () => {
    const { unmount } = mount({ preset: 'today' })
    await advance()
    unmount()
    await advance(60_000)
    await setVisibility('hidden')
    await setVisibility('visible')
    const event = new Event(ADMIN_REFRESH_EVENT, { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(get).toHaveBeenCalledTimes(1)
  })
})
