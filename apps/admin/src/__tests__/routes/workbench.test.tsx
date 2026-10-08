// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ accountsLogin: true, accountsSync: true, failToday: false }))
const requests = vi.hoisted(() => [] as string[])
const patch = vi.hoisted(() => vi.fn(async () => ({ note: '合作方' })))

vi.mock('../../lib/api-client', () => {
  const window = { from: Date.now() - 1000, to: Date.now() }
  const overview = {
    window,
    truncated: false,
    summary: {
      users: 1,
      devices: 0,
      tasks: 3,
      completed: 2,
      failed: 1,
      queued: 0,
      in_progress: 0,
      reconciling: 0,
    },
    actors: [
      {
        kind: 'user',
        id: 'user-1',
        username: 'alice',
        note: '设计师',
        tasks: 3,
        completed: 2,
        failed: 1,
        queued: 0,
        in_progress: 0,
        reconciling: 0,
        last_submitted_at: Date.now(),
      },
    ],
  }
  const user = {
    id: 'user-1',
    username: 'alice',
    note: null,
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    last_login_at: Date.now(),
    login_methods: ['password'],
    last_task_at: Date.now(),
    last_activity_at: Date.now(),
    active_sessions: 1,
    task_count: 0,
  }

  async function get(url: string): Promise<unknown> {
    requests.push(url)
    if (url === '/api/me') {
      return {
        ok: true,
        accounts_login: session.accountsLogin,
        accounts_sync: session.accountsSync,
      }
    }
    if (url === '/api/extensions') return { navigation: [], user_links: [] }
    if (url.startsWith('/api/overview/errors')) return { window, total: 0, entries: [] }
    if (url.startsWith('/api/overview')) {
      if (session.failToday) throw new Error('today unavailable')
      return overview
    }
    if (url.startsWith('/api/client-errors')) {
      return {
        range: '7d',
        bucket_unit: 'day',
        summary: { events: 3, devices: 2, boot_events: 2, groups: 1 },
        trend: [],
        groups: [
          {
            fingerprint: 'aaaaaaaaaaaaaaaa',
            kind: 'boot',
            name: 'BootFailure',
            message: 'timeout',
            count: 2,
            devices: 2,
            users: 0,
            first_seen: Date.now() - 3600_000,
            last_seen: Date.now() - 60_000,
            last_url: null,
            last_release: null,
          },
        ],
      }
    }
    if (url.startsWith('/api/tasks?'))
      return {
        window,
        tasks: [
          {
            id: 'task-1',
            user_id: 'user-1',
            device_id: 'device-1',
            username: 'alice',
            provider: 'openai-compat',
            model: 'gpt-image-2',
            status: 'failed',
            submitted_at: Date.now(),
            started_at: null,
            completed_at: null,
            error_type: 'upstream_error',
            upstream_status: 500,
            prompt: '商品主图',
            attempt_count: 1,
            upstream_invocation_count: 1,
          },
        ],
        nextCursor: null,
      }
    if (url.includes('/tasks')) return { tasks: [], nextCursor: null }
    if (url.startsWith('/api/users/')) {
      return {
        user,
        volume: [],
        volume_bucket: 'day',
        volume_range: '30d',
        template_count: 4,
        asset_count: 12,
        asset_bytes: 3 * 1024 * 1024,
      }
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
    // 横幅读的是完整快照：每一栏都取不到时它什么都不显示。
    if (url.startsWith('/api/ops')) {
      const unavailable = { ok: false, error: 'unavailable' }
      return {
        generated_at: Date.now(),
        host: unavailable,
        services: unavailable,
        queue: unavailable,
        database: unavailable,
        backup: unavailable,
        containers: unavailable,
        api: unavailable,
        reliability: unavailable,
        deployments: unavailable,
      }
    }
    throw new Error(`unexpected request: ${url}`)
  }

  return { apiClient: { get, patch }, ApiError: class extends Error {} }
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
  patch.mockClear()
  requests.length = 0
  session.failToday = false
  session.accountsLogin = true
  session.accountsSync = true
  document.cookie = 'sidebar_state=; path=/; max-age=0'
})

describe('user notes', () => {
  it('opens the note editor from the user list and saves the note', async () => {
    renderAt('/users')
    fireEvent.click(await screen.findByRole('button', { name: 'alice：添加备注' }))
    fireEvent.change(screen.getByRole('textbox', { name: '备注' }), {
      target: { value: '合作方' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存备注' }))
    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith('/api/users/user-1/note', { note: '合作方' })
    })
  })
})

async function navGroup(label: string) {
  return within(await screen.findByRole('list', { name: label }))
}

describe('sidebar navigation', () => {
  it('shows the user entry when accounts:login is enabled', async () => {
    renderAt('/overview')
    const business = await navGroup('经营')
    expect(await business.findByRole('link', { name: '用户' })).toBeInTheDocument()
    expect(business.getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(business.getByRole('link', { name: '生成任务' })).toBeInTheDocument()
  })

  it('hides the user entry when accounts:login is disabled', async () => {
    session.accountsLogin = false
    renderAt('/overview')
    const business = await navGroup('经营')
    expect(business.getByRole('link', { name: '概览' })).toBeInTheDocument()
    expect(business.queryByRole('link', { name: '用户' })).not.toBeInTheDocument()
  })

  it('groups the operational content and settings modules', async () => {
    renderAt('/overview')
    const content = await navGroup('运营内容')
    expect(content.getByRole('link', { name: '灵感库' })).toBeInTheDocument()
    expect(content.getByRole('link', { name: '技能目录' })).toBeInTheDocument()
    expect(content.getByRole('link', { name: '分类' })).toBeInTheDocument()
    const settings = await navGroup('设置')
    expect(settings.getByRole('link', { name: '审计' })).toBeInTheDocument()
  })

  it('marks only the exact inspiration module as active', async () => {
    renderAt('/inspirations/categories')
    const content = await navGroup('运营内容')
    expect(content.getByRole('link', { name: '分类' })).toHaveAttribute('data-active', 'true')
    expect(content.getByRole('link', { name: '灵感库' })).toHaveAttribute('data-active', 'false')
  })

  it('keeps 刷新 and 退出登录 in the sidebar footer', async () => {
    renderAt('/overview')
    expect(await screen.findByRole('button', { name: '刷新' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
  })

  it('restores the collapsed state from the sidebar cookie', async () => {
    document.cookie = 'sidebar_state=false; path=/'
    renderAt('/overview')
    await navGroup('经营')
    expect(document.querySelector('[data-state="collapsed"]')).not.toBeNull()
  })

  it('defaults to an expanded sidebar without a cookie', async () => {
    renderAt('/overview')
    await navGroup('经营')
    expect(document.querySelector('[data-state="collapsed"]')).toBeNull()
  })
})

describe('sync footprint', () => {
  it('shows the template, asset and byte counts when accounts:sync is enabled', async () => {
    renderAt('/users/user-1')
    expect(await screen.findByText('模板')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('素材')).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('素材占用')).toBeInTheDocument()
    expect(screen.getByText('3.0 MB')).toBeInTheDocument()
  })

  it('hides the sync footprint when accounts:sync is disabled', async () => {
    session.accountsSync = false
    renderAt('/users/user-1')
    expect(await screen.findByLabelText('任务状态筛选')).toBeInTheDocument()
    expect(screen.queryByText('模板')).not.toBeInTheDocument()
    expect(screen.queryByText('素材占用')).not.toBeInTheDocument()
  })
})

describe('今日概览', () => {
  it('shows generation users and links to their exact daily tasks instead of unrelated statistics', async () => {
    renderAt('/overview')
    expect(await screen.findByText('今天谁在生成')).toBeInTheDocument()
    const user = await screen.findByRole('link', { name: '设计师' })
    expect(user.getAttribute('href')).toMatch(/userId=user-1/)
    expect(user.getAttribute('href')).toMatch(/from=/)
    expect(user.getAttribute('href')).toMatch(/to=/)
    expect(screen.getByRole('link', { name: '设计师的失败任务' }).getAttribute('href')).toMatch(
      /status=failed/,
    )
    expect(screen.queryByText('Agent 输入缓存')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('时间范围')).not.toBeInTheDocument()
  })

  it('opens the same user and time window in the task list', async () => {
    renderAt('/overview')
    fireEvent.click(await screen.findByRole('link', { name: '设计师的失败任务' }))
    expect(await screen.findByRole('button', { name: '商品主图' })).toBeInTheDocument()
    const url = requests.find((url) => url.startsWith('/api/tasks?'))!
    const params = new URLSearchParams(url.split('?')[1])
    expect(params.get('userId')).toBe('user-1')
    expect(params.get('status')).toBe('failed')
    expect(params.has('from')).toBe(true)
    expect(params.has('to')).toBe(true)
  })

  it('still shows errors and health when the daily task query fails', async () => {
    session.failToday = true
    renderAt('/overview')
    expect(await screen.findByText(/今日任务加载失败/)).toBeInTheDocument()
    expect(await screen.findByText('今天没有采集到错误日志')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '服务健康' })).toBeInTheDocument()
  })

  it('keeps missing health data visibly unknown and shows the daily error list independently', async () => {
    renderAt('/overview')
    const health = within(await screen.findByRole('region', { name: '服务健康' }))
    expect(await health.findByRole('link', { name: /队列：未知/ })).toBeInTheDocument()
    expect(await screen.findByText('今天没有采集到错误日志')).toBeInTheDocument()
  })
})

describe('user detail controls', () => {
  it('renders no range control on the user detail page', async () => {
    renderAt('/users/user-1')
    expect(await screen.findByLabelText('任务状态筛选')).toBeInTheDocument()
    expect(screen.queryByLabelText('时间范围')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '运营操作' })).not.toBeInTheDocument()
    expect(screen.queryByText('积分账户')).not.toBeInTheDocument()
  })
})
