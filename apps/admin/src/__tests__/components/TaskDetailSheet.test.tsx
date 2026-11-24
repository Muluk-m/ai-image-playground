import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { TaskDetailSheet } from '../../components/TaskDetailSheet'

const { get, task, refetchTask } = vi.hoisted(() => ({
  get: vi.fn(),
  refetchTask: vi.fn(async () => undefined),
  task: { completed_at: Date.UTC(2026, 10, 24, 2, 0, 25) as number | null },
}))
vi.mock('../../lib/api-client', () => ({ apiClient: { get } }))
vi.mock('../../components/TaskDetailView', () => ({ TaskDetailView: () => null }))
vi.mock('../../lib/queries', () => ({
  useTask: () => ({
    refetch: refetchTask,
    data: {
      submitted_at: Date.UTC(2026, 10, 24, 2),
      started_at: Date.UTC(2026, 10, 24, 2),
      completed_at: task.completed_at,
      status: 'completed',
      attempt_count: 1,
      error_type: null,
    },
  }),
  useAudits: () => ({ data: { pages: [] } }),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search: object; children: ReactNode }) => (
    <a
      href={`${to}?${new URLSearchParams(Object.entries(search).map(([k, v]) => [k, String(v)]))}`}
    >
      {children}
    </a>
  ),
}))

const SUBMIT = 'a'.repeat(32)
const EXECUTE = 'b'.repeat(32)

it('shows the submit and execution traces of a task, and the fields behind each log line', async () => {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/ops/tasks/task-1/traces?') && !path.endsWith('&trees=1'))
      return {
        more: false,
        traces: [
          { traceId: SUBMIT, startedAt: Date.UTC(2026, 10, 24, 2) },
          { traceId: EXECUTE, startedAt: Date.UTC(2026, 10, 24, 2, 0, 1) },
        ],
      }
    if (path.startsWith('/api/ops/tasks/task-1/traces?'))
      return {
        more: false,
        traces: [
          {
            traceId: SUBMIT,
            startedAt: Date.UTC(2026, 10, 24, 2),
            tree: '+      0ms      28ms bff POST /v1/queue/submit',
            spans: 1,
            truncated: false,
          },
          {
            traceId: EXECUTE,
            startedAt: Date.UTC(2026, 10, 24, 2, 0, 1),
            tree: '+      0ms   24756ms worker task.execute\n+      1ms   21778ms   worker upstream POST',
            spans: 2,
            truncated: false,
          },
        ],
      }
    if (path.startsWith('/api/ops/logs?taskId=task-1'))
      return {
        entries: [
          {
            id: 'log-1',
            at: Date.UTC(2026, 10, 24, 2, 0, 1),
            level: 'info',
            message: 'upstream request finished',
            fields: { upstreamModel: 'gpt-image', elapsedMs: 21778 },
          },
        ],
      }
    throw new Error(`unexpected ${path}`)
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDetailSheet taskId="task-1" onOpenChange={() => {}} />
    </QueryClientProvider>,
  )

  expect(get.mock.calls.some(([path]) => String(path).endsWith('&trees=1'))).toBe(false)
  fireEvent.click(await screen.findByRole('tab', { name: '链路 2' }))
  // 打开抽屉只列链路；span 树等点开这一页才取。
  expect(await screen.findByRole('region', { name: `链路 ${SUBMIT}` })).toHaveTextContent(
    'bff POST /v1/queue/submit',
  )
  const execution = screen.getByRole('region', { name: `链路 ${EXECUTE}` })
  expect(execution).toHaveTextContent('worker upstream POST')
  expect(screen.getAllByRole('link', { name: '日志' })[1]).toHaveAttribute(
    'href',
    expect.stringContaining(`traceId=${EXECUTE}`),
  )

  fireEvent.click(screen.getByRole('tab', { name: '服务端日志 1' }))
  expect(screen.getByText('upstream request finished')).toBeInTheDocument()
  expect(screen.getByText(/"upstreamModel": "gpt-image"/)).toBeInTheDocument()
})

it('leaves the trace tab out when the deployment has no OpenObserve', async () => {
  get.mockImplementation(async (path: string) => {
    if (path.includes('/traces?')) throw new Error('observability_off')
    return {
      entries: [
        {
          id: 'log-1',
          at: Date.UTC(2026, 10, 24, 2),
          level: 'info',
          message: 'task started',
          fields: {},
        },
      ],
    }
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDetailSheet taskId="task-1" onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('tab', { name: '服务端日志 1' })).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: /^链路/ })).toBeNull()
})

it('keeps looking up to now for a task that has not finished, so a late execution still shows', async () => {
  task.completed_at = null
  get.mockReset()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  get.mockResolvedValue({ entries: [], traces: [], more: false })
  const before = Date.now()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDetailSheet taskId="task-1" onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(get).toHaveBeenCalled())
  for (const [path] of get.mock.calls) {
    const to = Number(new URL(String(path), 'http://admin').searchParams.get('to'))
    // 提交在几天前，窗口上界仍是现在，而不是提交后一分钟。
    expect(to).toBeGreaterThanOrEqual(before + 60_000)
  }
  // 每 30 秒前移窗口时也重取任务详情，任务结束后轮询才会停。
  await vi.advanceTimersByTimeAsync(30_000)
  expect(refetchTask).toHaveBeenCalledTimes(1)
  vi.useRealTimers()
  task.completed_at = Date.UTC(2026, 10, 24, 2, 0, 25)
})

it('keeps asking for traces while a just-finished task has not exported its spans yet', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  task.completed_at = Date.now() - 5_000
  get.mockReset()
  let exported = false
  get.mockImplementation(async (path: string) => {
    if (path.includes('/traces?'))
      return exported
        ? { more: false, traces: [{ traceId: EXECUTE, startedAt: Date.now() - 30_000 }] }
        : { more: false, traces: [] }
    return {
      entries: [
        { id: 'log-1', at: Date.now(), level: 'info', message: 'task completed', fields: {} },
      ],
    }
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDetailSheet taskId="task-1" onOpenChange={() => {}} />
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('tab', { name: '服务端日志 1' })).toBeInTheDocument()
  expect(screen.queryByRole('tab', { name: /^链路/ })).toBeNull()

  // span 随后入库：抽屉一直开着，链路页签自己出现。
  exported = true
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await screen.findByRole('tab', { name: '链路 1' })).toBeInTheDocument()

  // 过了收尾窗口就不再后台重取。
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  const calls = get.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(get.mock.calls.length).toBe(calls)
  vi.useRealTimers()
  task.completed_at = Date.UTC(2026, 10, 24, 2, 0, 25)
})
