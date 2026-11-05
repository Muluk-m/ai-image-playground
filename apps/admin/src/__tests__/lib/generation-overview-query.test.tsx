import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationOverviewResult } from '../../../contracts'
import type { GenerationSelection } from '../../lib/generation-overview'
import { useGenerationOverview } from '../../lib/queries'

const get = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api-client', () => ({ apiClient: { get } }))

const overview: GenerationOverviewResult = {
  window: { from: 0, to: 1 },
  actors: [],
  truncated: false,
  summary: {
    users: 0,
    devices: 0,
    tasks: 0,
    completed: 0,
    failed: 0,
    queued: 0,
    in_progress: 0,
    reconciling: 0,
  },
  activity: {
    window: { from: 0, to: 1 },
    tasks: [],
    client: { total: 0, entries: [] },
    server: { total: 0, entries: [] },
  },
}

let client: QueryClient
beforeEach(() => {
  vi.useFakeTimers()
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
  get.mockReset().mockResolvedValue(overview)
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(() => {
  cleanup()
  client.clear()
  focusManager.setFocused(undefined)
  onlineManager.setOnline(true)
  vi.useRealTimers()
})

function mount(selection: GenerationSelection) {
  return renderHook(() => useGenerationOverview(selection), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

describe('overview refresh cadence', () => {
  it.each([
    '1h',
    '6h',
    '24h',
  ] as const)('automatically refreshes the rolling %s window', async (preset) => {
    mount({ preset })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([
    '7d',
    '30d',
    'custom',
  ] as const)('loads %s once and refreshes only on demand', async (preset) => {
    const selection: GenerationSelection =
      preset === 'custom' ? { preset, from: Date.now() - 3600_000, to: Date.now() } : { preset }
    const { result } = mount(selection)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
      onlineManager.setOnline(false)
      onlineManager.setOnline(true)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(get).toHaveBeenCalledTimes(1)
    await act(async () => {
      await result.current.refetch()
    })
    expect(get).toHaveBeenCalledTimes(2)
  })
})
