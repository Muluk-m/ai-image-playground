import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { TaskDetail } from '../../../contracts'
import { TaskDetailView } from '../../components/TaskDetailView'
import { TooltipProvider } from '../../components/ui/tooltip'

const { taskQuery } = vi.hoisted(() => ({ taskQuery: vi.fn() }))
vi.mock('../../lib/queries', () => ({ useTask: taskQuery }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    search,
    children,
  }: {
    to: string
    search: Record<string, string | number>
    children: ReactNode
  }) => (
    <a
      href={`${to}?${new URLSearchParams(Object.entries(search).map(([key, value]) => [key, String(value)]))}`}
    >
      {children}
    </a>
  ),
}))

it('shows analysis findings, coverage and independent credits instead of an image result', () => {
  const task: TaskDetail = {
    id: 'analysis-result',
    kind: 'analysis',
    source: 'chat',
    provider: 'openai-compat',
    model: 'vision-model',
    status: 'completed',
    submitted_at: 1000,
    started_at: 1000,
    completed_at: 2000,
    error_type: null,
    upstream_status: null,
    prompt: '比较颜色',
    upstream_invocation_count: 1,
    attempt_count: 1,
    request_payload: { prompt: '比较颜色' },
    result_meta: { images: [] },
    error_message: null,
    upstream_body: null,
    device_id: null,
    user_id: null,
    next_retry_at: null,
    analysis: {
      pricing: {
        unit: 'kilo_token',
        quantity: 1,
        unitMultiplier: 1,
        pricingVersion: 'v1',
        quotedAt: 1000,
        validUntil: null,
        model: 'vision-model',
        baseUnitCredits: 6,
        outputPriceRatio: 5,
        cachedInputPriceRatio: 0.1,
        inputEstimateTokens: 100,
        outputReserveTokens: 1000,
        exemption: 'none',
      },
      reservedCredits: 31,
      actualCredits: 1,
      findings: [{ imageId: 'image-1', text: '颜色均匀' }],
      coverage: {
        requiredImageIds: ['image-1'],
        reviewedImageIds: ['image-1'],
        missingImageIds: [],
      },
      evidence: [],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
      upstreamRequestId: 'request-42',
      localRejection: null,
    },
  }
  taskQuery.mockReturnValue({ isPending: false, isError: false, data: task })
  render(
    <TooltipProvider>
      <TaskDetailView taskId={task.id} />
    </TooltipProvider>,
  )
  expect(screen.getByRole('heading', { name: '图片分析结果' })).toBeInTheDocument()
  expect(screen.getByText('颜色均匀')).toBeInTheDocument()
  expect(screen.getByText('已检查 1 / 1 张')).toBeInTheDocument()
  expect(screen.getByText('实扣 1 积分')).toBeInTheDocument()
  expect(screen.getByText('输入 100 · 缓存 80 · 输出 20 tokens')).toBeInTheDocument()
  expect(screen.queryByText('无输出图')).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: '在提示词页查看' })).not.toBeInTheDocument()
})

it.each([
  'chat',
  'manual',
] as const)('shows %s source and links only Chat generation tasks to their original prompt date', (source) => {
  const createdAt = Date.now() - 40 * 86400_000
  const task: TaskDetail = {
    id: 'queue-result',
    source,
    kind: 'queue',
    provider: 'openai-compat',
    model: 'image',
    status: 'completed',
    submitted_at: Date.now() - 1000,
    prompt_created_at: createdAt,
    started_at: null,
    completed_at: null,
    error_type: null,
    upstream_status: null,
    prompt: '杯子',
    upstream_invocation_count: 1,
    attempt_count: 1,
    request_payload: { prompt: '杯子' },
    result_meta: { images: [] },
    error_message: null,
    upstream_body: null,
    device_id: null,
    user_id: null,
    next_retry_at: null,
  }
  taskQuery.mockReturnValue({ isPending: false, isError: false, data: task })
  render(
    <TooltipProvider>
      <TaskDetailView taskId={task.id} />
    </TooltipProvider>,
  )
  expect(screen.getByText(source === 'chat' ? 'Chat' : '手动')).toBeInTheDocument()
  const link = screen.queryByRole('link', { name: '在提示词页查看' })
  if (source === 'manual') {
    expect(link).not.toBeInTheDocument()
    return
  }
  const url = new URL(link!.getAttribute('href')!, 'http://localhost')
  expect(url.pathname).toBe('/prompts')
  expect(url.searchParams.get('taskId')).toBe(task.id)
  expect(Number(url.searchParams.get('from'))).toBeLessThan(createdAt)
  expect(Number(url.searchParams.get('to'))).toBeGreaterThan(createdAt)
  expect(
    Number(url.searchParams.get('to')) - Number(url.searchParams.get('from')),
  ).toBeLessThanOrEqual(31 * 86400_000)
})
