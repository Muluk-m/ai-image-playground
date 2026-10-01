import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskReconciliation } from '../../components/TaskReconciliation'

afterEach(() => {
  vi.unstubAllGlobals()
})

it('keeps an uncertain command immutable, retries its ID and starts a fresh command for a new decision', async () => {
  const commands: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method !== 'POST')
        return Response.json({ upstreamTaskIds: [], dispatches: [], decisions: [] })
      commands.push(JSON.parse(String(init.body)))
      if (commands.length === 1) throw new TypeError('connection lost')
      if (commands.length === 2)
        return Response.json({
          taskId: 'task-1',
          status: 'reconciling',
          reason: 'manual_verification_required',
        })
      return Response.json({ taskId: 'task-1', status: 'failed' })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TaskReconciliation taskId="task-1" />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('核查依据'), { target: { value: 'provider case 1' } })
  fireEvent.click(screen.getByRole('button', { name: '查询原请求' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('结果尚不确定'))
  expect(screen.getByRole('button', { name: '确认未产生结果' })).toBeDisabled()
  expect(screen.getByLabelText('核查依据')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '重试原核查' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('需要向上游核实'))
  expect(commands[1]).toEqual(commands[0])
  fireEvent.click(screen.getByRole('button', { name: '确认未产生结果' }))
  await waitFor(() => expect(commands).toHaveLength(3))
  expect(commands[2]?.commandId).not.toBe(commands[0]?.commandId)
  expect(commands[2]?.action).toBe('confirm_no_result')
})

it('refreshes task state when another operator resolves an uncertain command', async () => {
  let status = 'reconciling'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === 'POST') throw new TypeError('connection lost')
      return Response.json({ status, upstreamTaskIds: [], dispatches: [], decisions: [] })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  render(
    <QueryClientProvider client={client}>
      <TaskReconciliation taskId="task-other-operator" />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText('核查依据'), { target: { value: 'operator A checking' } })
  fireEvent.click(screen.getByRole('button', { name: '查询原请求' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('结果尚不确定'))
  status = 'completed'
  fireEvent.click(screen.getByRole('button', { name: '刷新核查记录' }))
  await waitFor(() =>
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['task', 'task-other-operator'] }),
  )
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: '重试原核查' })).not.toBeInTheDocument(),
  )
  expect(screen.getByRole('button', { name: '确认未产生结果' })).toBeDisabled()
})

it('explains independent analysis evidence and token usage for manual reconciliation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        kind: 'analysis',
        status: 'reconciling',
        upstreamTaskIds: [],
        dispatches: [],
        decisions: [],
      }),
    ),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TaskReconciliation taskId="analysis-manual" />
    </QueryClientProvider>,
  )
  expect(await screen.findByLabelText('分析结果 JSON（findings 和 usage）')).toBeInTheDocument()
  expect(
    screen.getByText('请核实原分析请求的逐图结论和 token 用量；未知用量不能填写为 0。'),
  ).toBeInTheDocument()
})
