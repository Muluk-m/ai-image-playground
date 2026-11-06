// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({
  accountsLogin: true,
  accountsSync: true,
  failToday: false,
  showError: false,
  recoveryScenario: false,
  errorRequest: true,
  recentAvailable: true,
  errorCode: 'media_processing_busy',
  errorReason: 'object_lock_timeout' as string | null,
  taskAt: undefined as number | undefined,
  completedAt: undefined as number | undefined,
}))
const requests = vi.hoisted(() => [] as string[])
const patch = vi.hoisted(() => vi.fn(async () => ({ note: '合作方' })))

vi.mock('../../lib/api-client', () => {
  const window = { from: Date.now() - 1000, to: Date.now() }
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
    if (url.startsWith('/api/overview/errors') && session.recoveryScenario) {
      const recovered = {
        source: 'server',
        id: 'restored',
        at: window.from,
        service: 'cloudflared',
        instance: 'tunnel-1',
        message: 'rpc: connection closed',
        task_id: null,
        request_id: null,
        group: null,
        stack: null,
        recovery: {
          state: 'recovered',
          reason: '同一隧道连接已重新注册成功',
          recoveredAt: window.from + 100,
        },
      }
      return {
        window,
        total: 12,
        entries: [recovered],
        recovery: {
          unresolved: { total: 0, entries: [] },
          unknown: { total: 0, entries: [] },
          recovered: { total: 12, entries: [recovered] },
        },
      }
    }
    if (url.startsWith('/api/overview/errors'))
      return {
        window,
        total: session.showError ? 24 : 0,
        recent: session.recentAvailable
          ? { window: { from: window.to - 900_000, to: window.to }, total: 0, entries: [] }
          : undefined,
        entries: session.showError
          ? [
              {
                source: 'server',
                id: 'error-1',
                route: 'POST /api/media/:id/complete',
                status: 503,
                errorCode: session.errorCode,
                reason: session.errorReason,
                at: Date.now(),
                service: 'worker',
                message: '上游请求失败',
                stack: '    at callProvider (worker.ts:42)\n    at run (queue.ts:12)',
                instance: 'worker-1',
                task_id: null,
                request_id: session.errorRequest ? 'request-1' : null,
                group: 'generation.failed',
              },
            ]
          : [],
      }
    if (url.startsWith('/api/overview/generation')) {
      if (session.failToday) throw new Error('generation unavailable')
      const params = new URLSearchParams(url.split('?')[1])
      const selectedWindow = { from: Number(params.get('from')), to: Number(params.get('to')) }
      return {
        window: selectedWindow,
        summary: {
          users: 1,
          devices: 1,
          tasks: 4,
          completed: 1,
          failed: 1,
          in_progress: 1,
          queued: 1,
          reconciling: 0,
        },
        actors: [
          {
            kind: 'user',
            id: 'user-1',
            username: 'alice',
            note: '设计师',
            tasks: 3,
            completed: 1,
            failed: 1,
            in_progress: 1,
            queued: 0,
            reconciling: 0,
            last_submitted_at: window.to,
          },
          {
            kind: 'device',
            id: 'device-1',
            username: null,
            note: null,
            tasks: 1,
            completed: 0,
            failed: 0,
            in_progress: 0,
            queued: 1,
            reconciling: 0,
            last_submitted_at: window.from,
          },
        ],
        models: [],
        truncated: false,
        activity: {
          window: selectedWindow,
          tasks: [
            {
              id: 'overview-task',
              user_id: 'user-1',
              device_id: null,
              username: 'alice',
              provider: 'openai-compat',
              model: 'gpt-image-2',
              status: 'failed',
              submitted_at: selectedWindow.to - 100,
              started_at: null,
              completed_at: null,
              error_type: 'upstream_timeout',
              prompt: '概览任务详情',
            },
          ],
          server: {
            total: 1,
            entries: [
              {
                id: 'overview-server-error',
                at: selectedWindow.to - 100,
                message: '生成上游超时',
                stack: 'server stack',
                service: 'worker',
                task_id: 'overview-task',
                request_id: 'overview-request',
                instance: 'worker-1',
              },
            ],
          },
          client: {
            total: 1,
            entries: [
              {
                id: 'overview-client-error',
                at: selectedWindow.to - 100,
                message: '画布加载异常',
                stack: 'client stack',
                fingerprint: 'aaaaaaaaaaaaaaaa',
                username: 'alice',
                user_id: 'user-1',
                device_id: 'device-1',
              },
            ],
          },
        },
      }
    }
    if (url.startsWith('/api/client-errors/')) {
      return {
        fingerprint: 'aaaaaaaaaaaaaaaa',
        events: [
          {
            id: 'recovered',
            kind: 'boot',
            message: 'timeout',
            received_at: Date.now(),
            source: 'local',
            recovered_at: Date.now(),
          },
          {
            id: 'unknown',
            kind: 'boot',
            message: 'timeout',
            received_at: Date.now(),
            source: 'automation',
            recovered_at: null,
          },
        ],
      }
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
            sources: { local: 1, automation: 1, marked_test: 0, unclassified: 0 },
            recovered: 1,
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
    if (url.startsWith('/api/ops/logs')) {
      return {
        entries: [],
        nextCursor: null,
        summary: { total: 0, errors: 0, warnings: 0 },
        groups: [],
        trend: [],
        bucket_ms: 60_000,
        collectors: [],
      }
    }
    if (url.startsWith('/api/audits')) return { audits: [], nextCursor: null }
    if (url.startsWith('/api/tasks/')) {
      return {
        id: 'task-1',
        user_id: 'user-1',
        device_id: 'device-1',
        username: 'alice',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'failed',
        source: 'manual',
        submitted_at: session.taskAt ?? Date.now(),
        started_at: session.taskAt ?? Date.now(),
        completed_at: session.completedAt ?? null,
        error_type: 'upstream_error',
        upstream_status: 500,
        prompt: '商品主图',
        attempt_count: 1,
        upstream_invocation_count: 1,
        request_payload: { prompt: '商品主图', n: 1 },
        result_meta: { images: [] },
        error_message: 'upstream',
        upstream_body: null,
        next_retry_at: null,
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
            source: 'cli',
            submitted_at: session.taskAt ?? Date.now(),
            started_at: null,
            completed_at: session.completedAt ?? null,
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

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  session.errorCode = 'media_processing_busy'
  session.errorReason = 'object_lock_timeout'
  session.recentAvailable = true
  patch.mockClear()
  requests.length = 0
  session.failToday = false
  session.recoveryScenario = false
  session.showError = false
  session.errorRequest = true
  session.taskAt = undefined
  session.completedAt = undefined
  session.accountsLogin = true
  session.accountsSync = true
  localStorage.clear()
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
    expect(await screen.findAllByRole('button', { name: '刷新' })).not.toHaveLength(0)
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

describe('概览', () => {
  it('opens frontend error details and links backend errors and recent tasks to their exact context', async () => {
    renderAt('/overview?preset=6h')
    const recent = await screen.findByRole('link', { name: '概览任务详情' })
    const taskUrl = new URL(recent.getAttribute('href')!, 'http://localhost')
    expect(taskUrl.searchParams.get('task')).toBe('overview-task')
    expect(Number(taskUrl.searchParams.get('to')) - Number(taskUrl.searchParams.get('from'))).toBe(
      6 * 3600_000,
    )
    fireEvent.click(screen.getByRole('button', { name: /画布加载异常/ }))
    expect(await screen.findByRole('heading', { name: '前端错误详情' })).toBeInTheDocument()
    expect(screen.getByText(/client stack/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: /生成上游超时/ }))
    expect(await screen.findByRole('heading', { name: '后端错误详情' })).toBeInTheDocument()
    const log = new URL(
      screen.getByRole('link', { name: '相关日志 →' }).getAttribute('href')!,
      'http://localhost',
    )
    expect(log.searchParams.get('requestId')).toBe('overview-request')
    expect(
      Number(log.searchParams.get('to')) - Number(log.searchParams.get('from')),
    ).toBeLessThanOrEqual(120_000)
    expect(screen.getByRole('link', { name: '关联任务 →' })).toHaveAttribute(
      'href',
      expect.stringContaining('task=overview-task'),
    )
  })

  it('shows generation users and links each problem into tasks with the same owner and time range', async () => {
    renderAt('/overview?preset=6h')
    const owner = await screen.findByRole('link', { name: '设计师' })
    const failed = screen.getByRole('link', { name: '设计师的失败任务' })
    const href = new URL(failed.getAttribute('href')!, 'http://localhost')
    expect(href.searchParams.get('status')).toBe('failed')
    expect(href.searchParams.get('userId')).toBe('user-1')
    expect(Number(href.searchParams.get('to')) - Number(href.searchParams.get('from'))).toBe(
      6 * 3600_000,
    )
    expect(owner.closest('tr')).toHaveTextContent('alice')
    expect(screen.getByRole('link', { name: '匿名设备 device-1' })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '系统健康' })).not.toBeInTheDocument()
    expect(
      requests.some(
        (url) => url.startsWith('/api/overview?') || url.startsWith('/api/client-errors'),
      ),
    ).toBe(false)
  })

  it('shows a load failure instead of inventing generation records', async () => {
    session.failToday = true
    renderAt('/overview')
    expect(await screen.findByText(/生成记录加载失败/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: '设计师' })).not.toBeInTheDocument()
  })

  it('remembers the chosen rolling range after remounting without query parameters', async () => {
    const first = renderAt('/overview')
    fireEvent.click(await screen.findByRole('button', { name: '6 小时' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '6 小时' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    first.unmount()
    renderAt('/overview')
    expect(await screen.findByRole('button', { name: '6 小时' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await screen.findByRole('link', { name: '设计师' })
    const params = new URLSearchParams(
      requests
        .filter((url) => url.startsWith('/api/overview/generation'))
        .slice(-1)[0]!
        .split('?')[1],
    )
    expect(Number(params.get('to')) - Number(params.get('from'))).toBe(6 * 3600_000)
  })

  it('gives an explicit URL range precedence over the remembered range', async () => {
    localStorage.setItem('admin.overview.generation-range', JSON.stringify({ preset: '6h' }))
    renderAt('/overview?preset=1h')
    expect(await screen.findByRole('button', { name: '最近 1 小时' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await screen.findByRole('link', { name: '设计师' })
    expect(JSON.parse(localStorage.getItem('admin.overview.generation-range')!)).toEqual({
      preset: '1h',
    })
  })

  it('advances rolling windows on refresh and keeps the chosen duration', async () => {
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      renderAt('/overview?preset=1h')
      await screen.findByRole('link', { name: '设计师' })
      clock.mockReturnValue(start + 120_000)
      fireEvent.click(screen.getAllByRole('button', { name: '刷新' }).slice(-1)[0]!)
      await waitFor(() => {
        const params = new URLSearchParams(
          requests
            .filter((url) => url.startsWith('/api/overview/generation'))
            .slice(-1)[0]!
            .split('?')[1],
        )
        expect(Number(params.get('to'))).toBe(start + 120_000)
        expect(Number(params.get('from'))).toBe(start + 120_000 - 3600_000)
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps a custom range fixed and remembers it after leaving the page', async () => {
    const to = Date.now() - 3600_000
    const from = to - 6 * 3600_000
    const first = renderAt(`/overview?preset=custom&from=${from}&to=${to}`)
    await screen.findByRole('link', { name: '设计师' })
    expect(screen.getByRole('button', { name: '自定义' })).toHaveAttribute('aria-pressed', 'true')
    first.unmount()
    renderAt('/overview')
    await screen.findByRole('link', { name: '设计师' })
    const params = new URLSearchParams(
      requests
        .filter((url) => url.startsWith('/api/overview/generation'))
        .slice(-1)[0]!
        .split('?')[1],
    )
    expect(Number(params.get('from'))).toBe(from)
    expect(Number(params.get('to'))).toBe(to)
  })
})

describe('generation task drill-down', () => {
  it('shows CLI attribution in the task list and preserves the source filter', async () => {
    renderAt('/tasks?source=cli')
    const prompt = await screen.findByRole('button', { name: '商品主图' })
    expect(within(prompt.closest('tr')!).getByText('CLI')).toBeInTheDocument()
    const url = requests.find((url) => url.startsWith('/api/tasks?'))!
    expect(new URLSearchParams(url.split('?')[1]).get('source')).toBe('cli')
  })

  it('advances the default today window on refresh while keeping the status filter', async () => {
    const start = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      renderAt('/tasks?status=failed')
      await screen.findByRole('button', { name: '商品主图' })
      clock.mockReturnValue(start + 120_000)
      fireEvent.click(screen.getByRole('button', { name: '刷新' }))
      await waitFor(() => {
        const url = requests.filter((url) => url.startsWith('/api/tasks?')).slice(-1)[0]!
        const params = new URLSearchParams(url.split('?')[1])
        expect(Number(params.get('to'))).toBe(start + 120_000)
        expect(params.get('status')).toBe('failed')
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('shows invalid time windows without silently querying today and offers a valid reset', async () => {
    renderAt('/tasks?from=invalid&to=1234')
    expect(await screen.findByText(/任务筛选无效/)).toBeInTheDocument()
    expect(requests.some((url) => url.startsWith('/api/tasks?'))).toBe(false)
    fireEvent.click(screen.getByRole('link', { name: '查看今天全部任务' }))
    expect(await screen.findByRole('button', { name: '商品主图' })).toBeInTheDocument()
  })

  it('keeps an explicitly selected historical window on refresh', async () => {
    const to = Date.now() - 86400_000,
      from = to - 3600_000
    renderAt(`/tasks?from=${from}&to=${to}&userId=user-1`)
    await screen.findByRole('button', { name: '商品主图' })
    const count = requests.filter((url) => url.startsWith('/api/tasks?')).length
    fireEvent.click(screen.getAllByRole('button', { name: '刷新' }).slice(-1)[0]!)
    await waitFor(() =>
      expect(requests.filter((url) => url.startsWith('/api/tasks?')).length).toBeGreaterThan(count),
    )
    const url = requests.filter((url) => url.startsWith('/api/tasks?')).slice(-1)[0]!
    const params = new URLSearchParams(url.split('?')[1])
    expect(Number(params.get('from'))).toBe(from)
    expect(Number(params.get('to'))).toBe(to)
    expect(params.get('userId')).toBe('user-1')
  })

  it('loads server logs for the opened task inside that task window', async () => {
    const to = Date.now(),
      at = to - 20 * 86400_000
    session.taskAt = at
    session.completedAt = at + 30_000
    renderAt(`/tasks?from=${at - 3600_000}&to=${to}`)
    fireEvent.click(await screen.findByRole('button', { name: '商品主图' }))
    await waitFor(() => expect(requests.some((url) => url.startsWith('/api/ops/logs?'))).toBe(true))
    const params = new URLSearchParams(
      requests.find((url) => url.startsWith('/api/ops/logs?'))!.split('?')[1],
    )
    expect(params.get('taskId')).toBe('task-1')
    expect(Number(params.get('from'))).toBeLessThanOrEqual(at)
    expect(Number(params.get('to'))).toBeGreaterThanOrEqual(session.completedAt)
    expect(Number(params.get('to')) - Number(params.get('from'))).toBeLessThanOrEqual(7 * 86400_000)
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

it('keeps mixed frontend reports visible and distinguishes exact recovery from unknown', async () => {
  renderAt('/errors')
  expect(await screen.findByText(/本地预览 1 · 自动化浏览器 1/)).toHaveTextContent('已恢复 1/2')
  fireEvent.click(screen.getByRole('button', { name: '30 秒内没渲染出界面' }))
  expect(await screen.findByText('恢复未确认')).toBeInTheDocument()
  expect(screen.getByText(/^已恢复 ·/)).toBeInTheDocument()
  expect(screen.getByText('本地预览')).toBeInTheDocument()
  expect(screen.getByText('自动化浏览器')).toBeInTheDocument()
})
