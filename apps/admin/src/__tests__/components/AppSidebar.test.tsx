// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { overlayNavIsActive, overlayNavPath } from '@/components/AppSidebar'

const navigation = vi.hoisted(() => ({
  entries: [] as Array<{ label: string; href: string }>,
}))

vi.mock('../../lib/private-overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/private-overlay')>()
  return {
    ...actual,
    usePrivateAdminNavigation: () => navigation.entries,
  }
})

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    get: async (url: string) => {
      if (url === '/api/me') return { ok: true, accounts_login: true, accounts_sync: false }
      throw new Error(`unexpected request: ${url}`)
    },
    post: async () => ({}),
  },
  ApiError: class extends Error {},
}))

const { routeTree } = await import('../../routeTree.gen')

function renderAt(path: string): { history: { location: { pathname: string } } } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history,
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
  return { history }
}

async function settingsGroup(): Promise<ReturnType<typeof within>> {
  return within(await screen.findByRole('list', { name: '设置' }))
}

describe('overlayNavIsActive', () => {
  it('matches the extension path and its descendants, not a longer sibling', () => {
    expect(overlayNavPath('/billing/orders?status=open')).toBe('/billing/orders')
    expect(overlayNavPath('/billing/settings/')).toBe('/billing/settings')
    expect(overlayNavIsActive('/billing/orders', '/billing/orders')).toBe(true)
    expect(overlayNavIsActive('/billing/orders/ord-1', '/billing/orders')).toBe(true)
    expect(overlayNavIsActive('/billing/orders-archive', '/billing/orders')).toBe(false)
    expect(overlayNavIsActive('/billing/settings', '/billing/orders')).toBe(false)
    expect(overlayNavIsActive('/audit', '/')).toBe(false)
  })
})

describe('overlay sidebar links', () => {
  beforeEach(() => {
    navigation.entries = [
      { label: '订单核款', href: '/billing/orders' },
      { label: '计费设置', href: '/billing/settings' },
    ]
  })

  it('client-navigates extension pages instead of loading a new document', async () => {
    const { history } = renderAt('/overview')
    const settings = await settingsGroup()
    const orders = settings.getByRole('link', { name: '订单核款' })
    const billing = settings.getByRole('link', { name: '计费设置' })
    expect(orders).toHaveAttribute('href', '/billing/orders')
    expect(orders).toHaveAttribute('data-active', 'false')
    expect(billing).toHaveAttribute('data-active', 'false')

    fireEvent.click(billing)
    await waitFor(() => {
      expect(history.location.pathname).toBe('/billing/settings')
    })
  })

  it('shows the selected state for the extension page that is open', async () => {
    navigation.entries = [
      { label: '订单核款', href: '/overview' },
      { label: '计费设置', href: '/audit' },
    ]
    const { history } = renderAt('/audit')
    const settings = await settingsGroup()
    expect(settings.getByRole('link', { name: '计费设置' })).toHaveAttribute('data-active', 'true')
    expect(settings.getByRole('link', { name: '订单核款' })).toHaveAttribute('data-active', 'false')
    expect(settings.getByRole('link', { name: '审计' })).toHaveAttribute('data-active', 'true')

    fireEvent.click(settings.getByRole('link', { name: '订单核款' }))
    await waitFor(() => {
      expect(history.location.pathname).toBe('/overview')
    })
    expect(settings.getByRole('link', { name: '订单核款' })).toHaveAttribute('data-active', 'true')
    expect(settings.getByRole('link', { name: '计费设置' })).toHaveAttribute('data-active', 'false')
  })

  it('keeps a parent extension entry active on a nested path', async () => {
    navigation.entries = [{ label: '订单核款', href: '/users' }]
    renderAt('/users/user-1')
    const settings = await settingsGroup()
    expect(await settings.findByRole('link', { name: '订单核款' })).toHaveAttribute(
      'data-active',
      'true',
    )
  })
})
