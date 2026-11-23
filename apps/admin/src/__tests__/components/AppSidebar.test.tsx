// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NAV_GROUPS,
  overlayNavIsActive,
  overlayNavPath,
  resolveProvidersNavLabel,
} from '@/components/AppSidebar'

const navigation = vi.hoisted(() => ({
  entries: [] as Array<{ label: string; href: string }>,
}))

vi.mock('../../lib/private-overlay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/private-overlay')>()
  return {
    ...actual,
    usePrivateAdminNavigation: () => navigation.entries,
    usePrivateAdminBillingSettingsEnabled: () =>
      navigation.entries.some((entry) => entry.href === '/billing/settings'),
  }
})

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    get: async (url: string) => {
      if (url === '/api/me') return { ok: true, accounts_login: true, accounts_sync: false }
      if (url === '/api/extensions') return { navigation: navigation.entries, user_links: [] }
      if (url === '/api/models') return { models: [], channels: [] }
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

async function navGroup(name: '经营' | '设置'): Promise<ReturnType<typeof within>> {
  return within(await screen.findByRole('list', { name }))
}

describe('overlayNavIsActive & resolveProvidersNavLabel', () => {
  it('matches the extension path and its descendants, not a longer sibling', () => {
    expect(overlayNavPath('/billing/orders?status=open')).toBe('/billing/orders')
    expect(overlayNavPath('/billing/settings/')).toBe('/billing/settings')
    expect(overlayNavIsActive('/billing/orders', '/billing/orders')).toBe(true)
    expect(overlayNavIsActive('/billing/orders/ord-1', '/billing/orders')).toBe(true)
    expect(overlayNavIsActive('/billing/orders-archive', '/billing/orders')).toBe(false)
    expect(overlayNavIsActive('/billing/settings', '/billing/orders')).toBe(false)
    expect(overlayNavIsActive('/audit', '/')).toBe(false)
  })

  it('upgrades the gateway label when billing settings extension is present', () => {
    expect(resolveProvidersNavLabel([])).toBe('模型与网关')
    expect(resolveProvidersNavLabel([{ label: '计费设置', href: '/billing/settings' }])).toBe(
      '模型与计费',
    )
  })
})

describe('consolidated sidebar links', () => {
  beforeEach(() => {
    navigation.entries = [
      { label: '订单核款', href: '/billing/orders' },
      { label: '计费设置', href: '/billing/settings' },
    ]
  })

  it('places 订单核款 under 经营 and merges 计费设置 into 模型与计费', async () => {
    const { history } = renderAt('/overview')
    const business = await navGroup('经营')
    const settings = await navGroup('设置')

    const orders = business.getByRole('link', { name: '订单核款' })
    expect(orders).toHaveAttribute('href', '/billing/orders')
    expect(orders).toHaveAttribute('data-active', 'false')

    expect(settings.queryByRole('link', { name: '计费设置' })).not.toBeInTheDocument()
    const gateway = settings.getByRole('link', { name: '模型与计费' })
    expect(gateway).toHaveAttribute('href', '/providers')
    expect(gateway).toHaveAttribute('data-active', 'false')

    fireEvent.click(gateway)
    await waitFor(() => {
      expect(history.location.pathname).toBe('/providers')
    })
    expect(gateway).toHaveAttribute('data-active', 'true')
  })

  it('still renders and activates extra unknown extension entries in 设置', async () => {
    navigation.entries = [{ label: '合规导出', href: '/audit' }]
    renderAt('/audit')
    const settings = await navGroup('设置')
    expect(settings.getByRole('link', { name: '模型与网关' })).toHaveAttribute(
      'data-active',
      'false',
    )
    expect(settings.getByRole('link', { name: '合规导出' })).toHaveAttribute('data-active', 'true')
    expect(settings.getByRole('link', { name: '审计' })).toHaveAttribute('data-active', 'true')
  })
})

describe('prompt & feedback navigation', () => {
  it('includes the prompt ledger and user feedback inbox in business navigation', () => {
    const entries = NAV_GROUPS.find((group) => group.label === '经营')?.entries
    expect(entries).toContainEqual(expect.objectContaining({ to: '/prompts', label: '提示词' }))
    expect(entries).toContainEqual(
      expect.objectContaining({ to: '/feedback', label: '用户反馈', gated: true }),
    )
  })
})
