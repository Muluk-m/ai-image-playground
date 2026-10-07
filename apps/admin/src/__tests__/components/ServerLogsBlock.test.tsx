import type { ServerLogsResult } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerLogsBlock } from '../../components/ops/ServerLogsBlock'
import { apiClient } from '../../lib/api-client'

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
}
const get = vi.spyOn(apiClient, 'get')
afterEach(() => {
  vi.clearAllMocks()
})
function setup() {
  get.mockImplementation(async (url) =>
    url.includes('cursor=')
      ? { ...result, entries: [{ ...result.entries[0]!, id: 'older-log' }], nextCursor: null }
      : result,
  )
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ServerLogsBlock />
    </QueryClientProvider>,
  )
}

describe('server log exploration', () => {
  it('shows full-filter aggregates and applies literal search and event drill-down', async () => {
    setup()
    await screen.findByText('201')
    fireEvent.change(screen.getByLabelText('日志关键词'), { target: { value: '100%_timeout' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('q=100%25_timeout'))
    fireEvent.click(await screen.findByRole('button', { name: /worker \/ error.*task.failed/ }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('group=task.failed'))
    expect(get.mock.lastCall![0]).toContain('service=worker')
    expect(get.mock.lastCall![0]).toContain('level=error')
  })
  it('opens structured detail, correlates a request, and pauses when loading older logs', async () => {
    setup()
    await screen.findByText('upstream timeout', { selector: 'summary span' })
    fireEvent.click(screen.getByRole('button', { name: '同请求 request-1' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('requestId=request-1'))
    expect(await screen.findByText(/worker.ts:42/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '加载更早日志（暂停自动刷新）' }))
    await waitFor(() => expect(get.mock.lastCall![0]).toContain('cursor=older-page'))
    expect(await screen.findByRole('button', { name: '开启自动刷新' })).toBeInTheDocument()
    expect(await screen.findByText(/累计丢弃 2/)).toBeInTheDocument()
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
})
