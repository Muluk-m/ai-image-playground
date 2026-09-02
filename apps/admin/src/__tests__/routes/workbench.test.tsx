// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ accountsLogin: true }))

vi.mock('../../lib/api-client', () => {
  const overview = {
    summary: {
      total: 3,
      completed: 2,
      failed: 1,
      success_rate: 2 / 3,
      p50_duration_ms: 1200,
      p95_duration_ms: 4200,
      upstream_invocations: 4,
    },
    volume: [{ bucket_at: Date.now(), total: 3, completed: 2, failed: 1 }],
    failures: [{ error_type: 'upstream_timeout', count: 1 }],
    models: [{ model: 'gpt-image-2', count: 3, upstream_invocations: 4, average_multiplier: 1.33 }],
  }
  const user = {
    id: 'user-1',
    username: 'alice',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    last_login_at: Date.now(),
    last_task_at: Date.now(),
    last_activity_at: Date.now(),
    active_sessions: 1,
    task_count: 0,
  }

  async function get(url: string): Promise<unknown> {
    if (url === '/api/me') return { ok: true, accounts_login: session.accountsLogin }
    if (url === '/api/extensions') return { navigation: [], user_links: [] }
    if (url.startsWith('/api/overview')) return overview
    if (url.startsWith('/api/users/')) {
      return { user, tasks: [], nextCursor: null, volume: [] }
    }
    if (url.startsWith('/api/users')) {
      return {
        users: [user],
        truncated: false,
        kpis: {
          total_users: 1,
          active_users_7d: 1,
          submissions_24h: 0,
          failure_rate_24h: 0,
        },
      }
    }
    if (url.startsWith('/api/devices')) return { devices: [], truncated: false }
    throw new Error(`unexpected request: ${url}`)
  }

  class ApiError extends Error {}
  return {
    apiClient: {
      get,
      post: async () => ({ ok: true }),
      patch: async () => ({ ok: true }),
    },
    ApiError,
    UnauthorizedError: class extends ApiError {},
    setApiClientRefs: () => {},
    _resetApiClientRefsForTest: () => {},
  }
})

const { routeTree } = await import('../../routeTree.gen')

function renderAt(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

beforeEach(() => {
  session.accountsLogin = true
})

async function sidebarNav() {
  return within(await screen.findByRole('list', { name: '后台导航' }))
}

describe('sidebar navigation', () => {
  it('shows the user entry when accounts:login is enabled', async () => {
    renderAt('/overview')
    const nav = await sidebarNav()
    expect(await nav.findByRole('link', { name: '用户' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: '设备' })).toBeInTheDocument()
  })

  it('hides the user entry when accounts:login is disabled', async () => {
    session.accountsLogin = false
    renderAt('/overview')
    const nav = await sidebarNav()
    expect(nav.getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(nav.queryByRole('link', { name: '用户' })).not.toBeInTheDocument()
  })

  it('keeps 刷新 and 退出登录 in the sidebar footer', async () => {
    renderAt('/overview')
    expect(await screen.findByRole('button', { name: '刷新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
  })
})

describe('time range placement', () => {
  it('renders the range control next to the task pulse chart on 概览', async () => {
    renderAt('/overview')
    expect(await screen.findByLabelText('时间范围')).toBeInTheDocument()
  })

  it('renders no range control on the user detail page', async () => {
    renderAt('/users/user-1')
    expect(await screen.findByText('全部历史任务与账户操作')).toBeInTheDocument()
    expect(screen.queryByLabelText('时间范围')).not.toBeInTheDocument()
  })
})
