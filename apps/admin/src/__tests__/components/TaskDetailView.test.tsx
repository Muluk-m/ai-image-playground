import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { TaskDetail } from '../../../contracts'
import { TaskDetailView } from '../../components/TaskDetailView'
import { TooltipProvider } from '../../components/ui/tooltip'

const { taskQuery } = vi.hoisted(() => ({ taskQuery: vi.fn() }))
vi.mock('../../lib/queries', () => ({ useTask: taskQuery }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

it('shows analysis findings, coverage and independent credits instead of an image result', () => {
  const task: TaskDetail = {
    id: 'analysis-result',
    kind: 'analysis',
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
})
