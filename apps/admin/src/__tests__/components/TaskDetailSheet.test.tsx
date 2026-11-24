import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { TaskDetailSheet } from '../../components/TaskDetailSheet'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../lib/api-client', () => ({ apiClient: { get } }))
vi.mock('../../components/TaskDetailView', () => ({ TaskDetailView: () => null }))
vi.mock('../../lib/queries', () => ({
  useTask: () => ({
    data: {
      submitted_at: Date.UTC(2026, 10, 24, 2),
      started_at: Date.UTC(2026, 10, 24, 2),
      completed_at: Date.UTC(2026, 10, 24, 2, 0, 25),
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

  fireEvent.click(await screen.findByRole('tab', { name: '链路 2' }))
  expect(screen.getByRole('region', { name: `链路 ${SUBMIT}` })).toHaveTextContent(
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
