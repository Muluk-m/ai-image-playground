import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useUsers } from '../../lib/queries'

afterEach(() => vi.unstubAllGlobals())

it.each([
  { segments: true, expected: '/api/users?q=alice&page=2&segments=1' },
  { segments: false, expected: '/api/users?q=alice&page=2' },
  { segments: undefined, expected: '/api/users?q=alice&page=2' },
])('serializes the user list request with segments=$segments', async ({ segments, expected }) => {
  const fetch = vi.fn(() => Response.json({ users: [] }))
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { result, unmount } = renderHook(() => useUsers('alice', { page: 2, segments }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
  try {
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetch).toHaveBeenCalledExactlyOnceWith(expected, expect.anything())
  } finally {
    unmount()
    client.clear()
  }
})
