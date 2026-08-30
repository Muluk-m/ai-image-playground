// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminSession } from '../../../contracts'
import { TopBar } from '../../components/TopBar'

function renderTopBar(accountsLogin: boolean) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  queryClient.setQueryData<AdminSession>(['me'], {
    accounts_login: accountsLogin,
    ok: true,
  })

  const rootRoute = createRootRoute({ component: TopBar })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/overview' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/users' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/devices' }),
  ])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/overview'] }),
  })

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TopBar account capability', () => {
  it('hides user navigation when accounts:login is disabled', async () => {
    renderTopBar(false)
    expect(await screen.findByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '用户' })).not.toBeInTheDocument()
  })

  it('shows user navigation when accounts:login is enabled', async () => {
    renderTopBar(true)
    expect(await screen.findByRole('link', { name: '用户' })).toBeInTheDocument()
  })
})
