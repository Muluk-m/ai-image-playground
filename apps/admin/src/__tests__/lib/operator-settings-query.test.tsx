// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { operatorSettingsQueryKey, useOperatorSettings } from '../../lib/queries'

afterEach(() => vi.unstubAllGlobals())

it('keeps a saved operator revision when an older refresh arrives later', async () => {
  let finishRefresh = false
  let refreshStarted = false
  let requests = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      requests++
      if (requests > 1) {
        refreshStarted = true
        await waitFor(() => expect(finishRefresh).toBe(true))
      }
      return Response.json({ revision: 3, settings: [] })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result, unmount } = renderHook(() => useOperatorSettings(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  try {
    await waitFor(() => expect(result.current.data?.revision).toBe(3))
    let refresh: Promise<unknown> | undefined
    act(() => {
      refresh = result.current.refetch()
    })
    await waitFor(() => expect(refreshStarted).toBe(true))
    act(() => client.setQueryData(operatorSettingsQueryKey, { revision: 4, settings: [] }))
    await act(async () => {
      finishRefresh = true
      await refresh!
    })
    expect(result.current.data?.revision).toBe(4)
    expect(client.getQueryData(operatorSettingsQueryKey)).toEqual({ revision: 4, settings: [] })
  } finally {
    finishRefresh = true
    unmount()
    client.clear()
  }
})
