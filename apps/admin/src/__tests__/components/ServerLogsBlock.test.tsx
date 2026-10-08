import type { ServerLogsResult } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defaultParseSearch } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerLogsBlock } from '../../components/ops/ServerLogsBlock'
import { apiClient } from '../../lib/api-client'
import { parseServerLogSearch, type ServerLogSearch } from '../../lib/server-log-search'

const now = Date.now()
const result: ServerLogsResult = {
  entries: [
    {
      id: 'log-1',
      at: now,
      service: 'worker',
      instance: 'worker-1',
      version: 'release-1',
      level: 'error',
      event: 'task.failed',
      group_key: 'task.failed',
      message: 'upstream timeout',
      request_id: 'request-1',
      task_id: null,
      fields: { err: { stack: 'at worker.ts:42' } },
    },
  ],
  nextCursor: 'older-page',
  summary: { total: 201, errors: 150, warnings: 5 },
  groups: [
    {
      service: 'worker',
      level: 'error',
      key: 'task.failed',
      count: 150,
      first_at: now - 60000,
      last_at: now,
    },
  ],
  trend: [{ at: now, count: 201, errors: 150 }],
  bucket_ms: 60000,
  collectors: [
    {
      service: 'worker',
      instance: 'worker-1',
      last_seen_at: now,
      pending: 0,
      dropped: 2,
      failures: 1,
      last_written_at: now,
    },
  ],
  coverage: { first_at: now - 60000, last_at: now },
}
const get = vi.spyOn(apiClient, 'get')
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function setup() {
  get.mockImplementation(async (url) =>
    url.includes('cursor=')
      ? { ...result, entries: [{ ...result.entries[0]!, id: 'older-log' }], nextCursor: null }
      : result,
  )
  const view = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ServerLogsBlock />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByText('更多查询条件'))
  return view
}

describe('server log exploration', () => {
  it('resumes a fresh relative window after leaving a shared fixed range and preserves manual pause', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    get.mockResolvedValue(result)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const block = (searchState: ServerLogSearch) => (
      <QueryClientProvider client={client}>
        <ServerLogsBlock searchState={searchState} />
      </QueryClientProvider>
    )
    const view = render(block({ from: now - 3600000, to: now }))
    await screen.findByText('201')
    vi.setSystemTime(now + 7200000)
    view.rerender(block({}))
    await waitFor(() => {
      const params = new URL(get.mock.lastCall![0], 'http://localhost').searchParams
      expect(Number(params.get('to'))).toBe(now + 7200000)
      expect(Number(params.get('to')) - Number(params.get('from'))).toBe(86400_000)
    })
    fireEvent.click(screen.getByRole('button', { name: '暂停自动刷新' }))
    view.rerender(block({ q: 'timeout' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('q=timeout'))
    expect(screen.getByRole('button', { name: '开启自动刷新' })).toBeInTheDocument()
  })
  it('reflects fixed dates and clears old date drafts before applying identity filters in a preset range', async () => {
    setup()
    await screen.findByText('201')
    const dateInput = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, -1)
    fireEvent.change(screen.getByLabelText('开始时间（北京时间）'), {
      target: { value: dateInput(now - 7200000) },
    })
    fireEvent.change(screen.getByLabelText('结束时间（北京时间）'), {
      target: { value: dateInput(now) },
    })
    fireEvent.click(screen.getByRole('button', { name: '应用范围与定位' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain(`from=${now - 7200000}`))
    expect(screen.getByLabelText('开始时间（北京时间）')).toHaveValue(dateInput(now - 7200000))
    fireEvent.change(screen.getByLabelText('日志时间范围'), { target: { value: '1h' } })
    expect(screen.getByLabelText('开始时间（北京时间）')).toHaveValue('')
    expect(screen.getByLabelText('结束时间（北京时间）')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: 'user-new' } })
    fireEvent.click(screen.getByRole('button', { name: '应用范围与定位' }))
    await waitFor(() => {
      const params = new URL(get.mock.lastCall![0], 'http://localhost').searchParams
      expect(params.get('userId')).toBe('user-new')
      expect(Number(params.get('to')) - Number(params.get('from'))).toBe(3600_000)
    })
    expect(screen.getByRole('button', { name: '暂停自动刷新' })).toBeInTheDocument()
  })
  it('copies a fixed query window and reports clipboard failures', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    setup()
    await screen.findByText('201')
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: 'decode failed' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('q=decode+failed'))
    fireEvent.click(screen.getByRole('button', { name: '复制查询链接' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('复制失败')
    fireEvent.click(screen.getByRole('button', { name: '复制查询链接' }))
    await screen.findByRole('button', { name: '已复制查询链接' })
    const restored = parseServerLogSearch(
      defaultParseSearch(new URL(writeText.mock.lastCall![0]).search),
    )
    expect(restored.q).toBe('decode failed')
    expect(restored.to! - restored.from!).toBe(86400_000)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it.each([
    '500',
    'true',
    'null',
  ])('preserves literal %s in a reopened copied link', async (literal) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    setup()
    await screen.findByText('201')
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: literal } })
    fireEvent.change(screen.getByLabelText('版本'), { target: { value: literal } })
    fireEvent.click(screen.getByRole('button', { name: '应用范围与定位' }))
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(screen.getByRole('button', { name: '复制查询链接' }))
    await screen.findByRole('button', { name: '已复制查询链接' })
    const restored = parseServerLogSearch(
      defaultParseSearch(new URL(writeText.mock.lastCall![0]).search),
    )
    expect(restored.q).toBe(literal)
    expect(restored.version).toBe(literal)
  })
  it('defaults to a day and exposes the retained boundary before interpreting no matches', async () => {
    setup()
    await screen.findByText('201')
    fireEvent.click(await screen.findByText('事件聚合与留存范围'))
    await screen.findByText(/当前留存记录/)
    const params = new URL(get.mock.lastCall![0], 'http://localhost').searchParams
    expect(Number(params.get('to')) - Number(params.get('from'))).toBe(86400_000)
    expect(screen.getByText(/此前记录可能尚未采集或已清理/)).toBeInTheDocument()
  })
  it('restores fixed URL filters and permits exact identity lookup without entering dates', async () => {
    get.mockResolvedValue(result)
    const onSearchChange = vi.fn()
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ServerLogsBlock
          searchState={{ from: now - 3600000, to: now, userId: 'u-1', mediaId: 'm-1' }}
          onSearchChange={onSearchChange}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('201')
    fireEvent.click(screen.getByText('更多查询条件'))
    expect(get.mock.lastCall![0]).toContain('userId=u-1')
    expect(get.mock.lastCall![0]).toContain('mediaId=m-1')
    fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: 'u-2' } })
    fireEvent.click(screen.getByRole('button', { name: '应用范围与定位' }))
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: now - 3600000, to: now, userId: 'u-2', mediaId: 'm-1' }),
    )
  })
  it('shows full-filter aggregates and applies literal search and event drill-down', async () => {
    setup()
    await screen.findByText('201')
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: '100%_timeout' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('q=100%25_timeout'))
    fireEvent.click(await screen.findByText('事件聚合与留存范围'))
    fireEvent.click(await screen.findByRole('button', { name: /worker \/ error.*task.failed/ }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('group=task.failed'))
    expect(get.mock.lastCall![0]).toContain('service=worker')
    expect(get.mock.lastCall![0]).toContain('level=error')
  })
  it('opens structured detail, correlates a request, and pauses when loading older logs', async () => {
    setup()
    await screen.findByText('upstream timeout', { selector: 'button span' })
    fireEvent.click(await screen.findByText('事件聚合与留存范围'))
    fireEvent.click(await screen.findByRole('button', { name: /worker \/ error.*task.failed/ }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('group=task.failed'))
    fireEvent.click(await screen.findByRole('button', { name: 'ERROR worker upstream timeout' }))
    fireEvent.click(await screen.findByRole('button', { name: '同请求 request-1' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('requestId=request-1'))
    const params = new URL(get.mock.lastCall![0], 'http://localhost').searchParams
    for (const key of ['service', 'level', 'q', 'group', 'taskId'])
      expect(params.has(key)).toBe(false)
    fireEvent.click(await screen.findByRole('button', { name: 'ERROR worker upstream timeout' }))
    expect(await screen.findByText(/worker.ts:42/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    fireEvent.click(screen.getByRole('button', { name: '加载更早日志（暂停自动刷新）' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('cursor=older-page'))
    expect(await screen.findByRole('button', { name: '开启自动刷新' })).toBeInTheDocument()
    expect(screen.queryByText(/累计丢弃 2/)).not.toBeInTheDocument()
  })
  it('makes read failures visible and keeps a retry control', async () => {
    get.mockRejectedValue(new Error('unavailable'))
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ServerLogsBlock />
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('日志加载失败')
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
  it('keeps records through a window refresh and its failure, but clears them for a new filter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    setup()
    await screen.findByText('201')
    let failRefresh: (error: Error) => void = () => {}
    get.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRefresh = reject
        }),
    )
    vi.setSystemTime(Date.now() + 1000)
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    expect(screen.getByText('201')).toBeInTheDocument()
    expect(await screen.findByText(/正在刷新日志/)).toBeInTheDocument()
    failRefresh(new Error('offline'))
    expect(await screen.findByRole('alert')).toHaveTextContent('保留上次成功读取')
    expect(screen.getByText('201')).toBeInTheDocument()
    get.mockRejectedValue(new Error('offline'))
    fireEvent.change(screen.getByLabelText('日志服务'), { target: { value: 'bff' } })
    await waitFor(() => expect(screen.queryByText('201')).not.toBeInTheDocument())
    expect(await screen.findByRole('alert')).toHaveTextContent('日志加载失败')
  })
  it('applies typed field search and refuses invalid field values', async () => {
    setup()
    await screen.findByText('201')
    fireEvent.change(screen.getByLabelText('日志关键词'), {
      target: { value: 'service:worker level:error timeout' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('service=worker'))
    expect(get.mock.lastCall![0]).toContain('level=error')
    expect(get.mock.lastCall![0]).toContain('q=timeout')
    expect(screen.getByLabelText('日志关键词')).toHaveValue('service:worker level:error timeout')
    fireEvent.click(screen.getByRole('button', { name: '全部级别' }))
    await waitFor(() =>
      expect(screen.getByLabelText('日志关键词')).toHaveValue('service:worker timeout'),
    )
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).not.toContain('level=error'))
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).not.toContain('level=error'))
    expect(get.mock.lastCall![0]).not.toContain('service=worker')
    expect(get.mock.lastCall![0]).not.toContain('q=timeout')
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: 'level:banana' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('日志级别无效')
  })
  it('loads context only after opening a log and requesting it', async () => {
    setup()
    await screen.findByText('201')
    expect(get.mock.calls.some(([url]) => url.includes('/context'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'ERROR worker upstream timeout' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看同容器前后 50 行' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toBe('/api/ops/logs/context?id=log-1'))
    expect(await screen.findByLabelText('日志上下文')).toHaveTextContent('upstream timeout')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('button', { name: '开启自动刷新' })).toBeInTheDocument()
  })
})
