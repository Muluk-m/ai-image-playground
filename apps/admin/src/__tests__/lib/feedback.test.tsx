import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFeedbackThread } from '../../lib/feedback'

const get = vi.hoisted(() => vi.fn())
vi.mock('../../lib/api-client', () => ({ apiClient: { get } }))

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.useRealTimers()
})

it('refreshes the latest messages when the open conversation moves outside the inbox page', async () => {
  vi.useFakeTimers()
  focusManager.setFocused(true)
  get.mockClear().mockResolvedValue({ messages: [], hasMore: false })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  const initialProps: { revision?: number; before?: number } = { revision: 1_795_000_000_000 }
  const { rerender } = renderHook(
    ({ revision, before }: { revision?: number; before?: number }) =>
      useFeedbackThread('thread-1', before, revision),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    },
  )
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  await advance(30_000)
  expect(get).toHaveBeenCalledTimes(1)

  rerender({})
  await advance(30_000)
  expect(get.mock.calls).toEqual([
    ['/api/feedback/thread-1'],
    ['/api/feedback/thread-1'],
    ['/api/feedback/thread-1'],
  ])

  rerender({ before: 1_795_000_000_000 })
  await advance(30_000)
  expect(get).toHaveBeenCalledTimes(4)
  expect(get).toHaveBeenLastCalledWith('/api/feedback/thread-1?before=1795000000000')
})
