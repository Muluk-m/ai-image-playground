// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ accountsLogin: true, accountsSync: true }))
const patch = vi.hoisted(() => vi.fn(async () => ({ note: '合作方' })))

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
      queue_p50_ms: 800,
    },
    pulse: {
      current: {
        tasks: 3,
        completed: 2,
        failed: 1,
        images: 5,
        active: 2,
        signups: 1,
        agent_turns: 4,
        agent_failed: 0,
        agent_aborted: 1,
      },
      previous: {
        tasks: 2,
        completed: 2,
        failed: 0,
        images: 4,
        active: 2,
        signups: 0,
        agent_turns: 1,
        agent_failed: 0,
        agent_aborted: 0,
      },
      series: [
        {
          bucket_at: Date.now(),
          tasks: 3,
          images: 5,
          active: 2,
          signups: 1,
          agent_completed: 3,
          agent_failed: 0,
          agent_aborted: 1,
        },
      ],
    },
    volume: [{ bucket_at: Date.now(), total: 3, completed: 2, failed: 1 }],
    volume_bucket: 'day',
    failures: [{ error_type: 'upstream_timeout', count: 1, previous_count: 0 }],
    agent_cache: {
      calls: 2,
      input_tokens: 1000,
      cache_read_tokens: 640,
      first_call: { calls: 1, input_tokens: 900, cache_read_tokens: 600 },
      continuation: { calls: 1, input_tokens: 100, cache_read_tokens: 40 },
      models: [
        { model: 'model-b', calls: 1, input_tokens: 900, cache_read_tokens: 600 },
        { model: 'model-a', calls: 1, input_tokens: 100, cache_read_tokens: 40 },
      ],
    },
    models: [
      {
        model: 'gpt-image-2',
        count: 3,
        upstream_invocations: 4,
        average_multiplier: 1.33,
        completed: 2,
        failed: 1,
        queue_p50_ms: 800,
        run_p95_ms: 4200,
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
    if (url === '/api/me') {
      return {
        ok: true,
        accounts_login: session.accountsLogin,
        accounts_sync: session.accountsSync,
      }
    }
    if (url === '/api/extensions') return { navigation: [], user_links: [] }
    if (url.startsWith('/api/overview')) return overview
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
    expect(business.getByRole('link', { name: '任务与设备' })).toBeInTheDocument()
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

describe('概览 command center', () => {
  it('compares business numbers with the previous window', async () => {
    renderAt('/overview')
    const kpis = within(await screen.findByRole('region', { name: '业务指标' }))
    expect(kpis.getByText('提交任务')).toBeInTheDocument()
    expect(kpis.getByText('+50.0%')).toBeInTheDocument()
    expect(kpis.getByText('新注册')).toBeInTheDocument()
  })

  it('lights each subsystem and lists boot failures under 需要处理', async () => {
    renderAt('/overview')
    const health = within(await screen.findByRole('region', { name: '系统健康' }))
    expect(health.getByRole('link', { name: /前端：注意，2/ })).toHaveAttribute('href', '/errors')
    // 运维快照每一栏都取不到：灯显示取不到，不冒充正常。
    expect(health.getByRole('link', { name: /队列：未知/ })).toBeInTheDocument()
    expect(
      await screen.findByText('2 次启动失败，用户看到「工作台暂时无法打开」'),
    ).toBeInTheDocument()
  })
})

describe('time range placement', () => {
  it('shows the token-weighted Agent cache hit rate and per-model usage', async () => {
    renderAt('/overview')
    expect(await screen.findByText('Agent 输入缓存 · 7 天')).toBeInTheDocument()
    expect(screen.getByText('64.0%')).toBeInTheDocument()
    expect(screen.getByText('每轮首调')).toBeInTheDocument()
    expect(screen.getByText('轮内续调')).toBeInTheDocument()
    expect(
      within(screen.getByRole('row', { name: /model-b/ })).getByText('66.7%'),
    ).toBeInTheDocument()
  })

  it('renders one range control for the whole 概览 page', async () => {
    renderAt('/overview')
    expect(await screen.findAllByLabelText('时间范围')).toHaveLength(1)
  })

  it('renders no range control on the user detail page', async () => {
    renderAt('/users/user-1')
    expect(await screen.findByLabelText('任务状态筛选')).toBeInTheDocument()
    expect(screen.queryByLabelText('时间范围')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: '运营操作' })).not.toBeInTheDocument()
    expect(screen.queryByText('积分账户')).not.toBeInTheDocument()
  })
})
