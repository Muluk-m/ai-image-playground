// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const queryState = vi.hoisted(() => ({
  filters: [] as Array<Record<string, string | number | undefined>>,
}))

vi.mock('../../components/Page', () => ({
  Page: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <main>
      <div>{actions}</div>
      {children}
    </main>
  ),
  EmptyState: ({ label }: { label: string }) => <div>{label}</div>,
  ErrorState: ({ label }: { label: string }) => <div>{label}</div>,
  PendingState: ({ label }: { label: string }) => <div>{label}</div>,
}))
vi.mock('../../components/FuzzyTime', () => ({ FuzzyTime: () => <span>刚刚</span> }))
vi.mock('../../components/ShortId', () => ({
  ShortId: ({ value }: { value: string }) => <span>{value}</span>,
}))
vi.mock('../../hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('../../lib/queries', () => ({
  useOps: () => ({ data: undefined, isPending: false, isError: false, isFetching: false }),
  useUsers: () => ({ data: { users: [] } }),
  useAudits: (filters: Record<string, string | number | undefined>) => {
    queryState.filters.push(filters)
    return {
      data: {
        pages: [
          {
            audits: [
              {
                id: 'audit-1',
                operator_id: 'operator-1',
                action: 'operator_config.set',
                target_type: 'operator_config',
                target_id: 'cli:api',
                details: {
                  before: { enabled: false },
                  after: { enabled: true },
                  reason: 'incident',
                },
                created_at: Date.now(),
              },
            ],
          },
        ],
      },
      isPending: false,
      isError: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    }
  },
}))

const { routeTree } = await import('../../routeTree.gen')

function renderAt(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(['me'], { ok: true, accounts_login: true, accounts_sync: false })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

describe('audit filters', () => {
  it('reads operator, action and target filters from the URL and offers a before/after diff', async () => {
    queryState.filters.length = 0
    renderAt('/audit?operatorId=operator-1&settingKey=cli%3Aapi&targetId=cli%3Aapi')
    expect(await screen.findByText('设置运营覆盖')).toBeInTheDocument()
    await waitFor(() => {
      expect(queryState.filters[queryState.filters.length - 1]).toMatchObject({
        operatorId: 'operator-1',
        settingKey: 'cli:api',
        targetId: 'cli:api',
      })
    })
    expect(screen.getByRole('button', { name: '对比' })).toBeInTheDocument()
  })
})
