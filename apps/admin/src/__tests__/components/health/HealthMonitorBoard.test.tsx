// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  formatAvailability,
  formatLatencyMs,
  HealthMonitorBoard,
} from '@/components/health/HealthMonitorBoard'
import type { HealthMonitorSnapshot } from '@/lib/types'

function sampleSnapshot(): HealthMonitorSnapshot {
  const start = Date.UTC(2026, 10, 25, 2, 35, 0)
  const bucketMs = 5 * 60 * 1000
  const makeBuckets = (
    override: Partial<
      HealthMonitorSnapshot['groups'][number]['components'][number]['buckets'][number]
    >,
  ) => [
    {
      start_at: start,
      end_at: start + bucketMs,
      status: 'idle' as const,
      total: 0,
      succeeded: 0,
      failed: 0,
      success_rate: null,
    },
    {
      start_at: start + bucketMs,
      end_at: start + 2 * bucketMs,
      status: 'healthy' as const,
      total: 20,
      succeeded: 20,
      failed: 0,
      success_rate: 1,
      ...override,
    },
  ]

  return {
    generated_at: start + 2 * bucketMs,
    range: '6h',
    include_policy: false,
    bucket_ms: bucketMs,
    bucket_count: 2,
    window_start_at: start,
    window_end_at: start + 2 * bucketMs,
    summary: {
      status: 'healthy',
      availability: 0.995,
      generation_total: 40,
      generation_availability: 0.975,
      generation_p50_ms: 14_500,
      agent_total: 60,
      agent_availability: 1,
      agent_ttft_p50_ms: 1_820,
      api_total: 1200,
      api_availability: 1,
      api_p95_ms: 210,
    },
    groups: [
      {
        id: 'generation:openai-compat',
        kind: 'generation',
        name: 'OpenAI 兼容生成',
        status: 'degraded',
        availability: 0.975,
        total: 40,
        succeeded: 39,
        failed: 1,
        components: [
          {
            id: 'gen:gpt',
            kind: 'generation',
            name: 'gpt-image-1.5',
            badge: 'OpenAI 直连',
            status: 'healthy',
            availability: 1,
            total: 20,
            succeeded: 20,
            failed: 0,
            policy_blocked: 2,
            duration_p50_ms: 14_500,
            duration_p95_ms: 22_000,
            queue_wait_p50_ms: 850,
            buckets: makeBuckets({
              duration_p50_ms: 14_500,
              duration_p95_ms: 22_000,
              queue_wait_p50_ms: 850,
              policy_blocked: 2,
            }),
          },
        ],
      },
      {
        id: 'agent:models',
        kind: 'agent',
        name: 'Agent 对话模型',
        status: 'healthy',
        availability: 1,
        total: 60,
        succeeded: 60,
        failed: 0,
        components: [
          {
            id: 'agent:claude',
            kind: 'agent',
            name: 'claude-sonnet-4-6',
            badge: 'Agent',
            status: 'healthy',
            availability: 1,
            total: 60,
            succeeded: 60,
            failed: 0,
            ttft_p50_ms: 1_820,
            ttft_p95_ms: 3_100,
            duration_p50_ms: 6_400,
            duration_p95_ms: 12_000,
            buckets: makeBuckets({
              ttft_p50_ms: 1_820,
              ttft_p95_ms: 3_100,
              duration_p50_ms: 6_400,
              duration_p95_ms: 12_000,
            }),
          },
        ],
      },
    ],
  }
}

describe('HealthMonitorBoard formatting', () => {
  it('formats availability and latency cleanly', () => {
    expect(formatAvailability(null)).toBe('—')
    expect(formatAvailability(1)).toBe('100%')
    expect(formatAvailability(0.9959)).toBe('99.59%')
    expect(formatLatencyMs(null)).toBe('—')
    expect(formatLatencyMs(420)).toBe('420ms')
    expect(formatLatencyMs(1_820)).toBe('1.82s')
    expect(formatLatencyMs(14_500)).toBe('14.5s')
    expect(formatLatencyMs(90_000)).toBe('1.5m')
  })
})

describe('HealthMonitorBoard interactions', () => {
  it('renders KPI overview, collapses groups, and shows TTFT & generation hover popovers', () => {
    render(<HealthMonitorBoard snapshot={sampleSnapshot()} />)

    expect(screen.getByText('99.50%')).toBeInTheDocument()
    expect(screen.getByText(/TTFT 中位数 1\.82s/)).toBeInTheDocument()
    expect(screen.getByText(/耗时 P50 14\.5s · 40 次/)).toBeInTheDocument()

    // Hover an Agent bucket pill -> shows TTFT median and P95 tooltip via aria-describedby.
    const agentPills = screen.getAllByRole('button', { name: /claude-sonnet-4-6/ })
    expect(agentPills[0]).toHaveAttribute('tabindex', '-1')
    expect(agentPills[1]).toHaveAttribute('tabindex', '0')
    fireEvent.mouseEnter(agentPills[1]!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('首 Token 中位数')
    expect(screen.getByText('1.82s')).toBeInTheDocument()
    expect(screen.getByText('3.10s')).toBeInTheDocument()

    // Keyboard Escape dismisses the tooltip; ArrowLeft navigates to previous bucket.
    fireEvent.keyDown(agentPills[1]!, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    fireEvent.keyDown(agentPills[1]!, { key: 'ArrowLeft' })
    expect(screen.getByRole('tooltip')).toHaveTextContent('无流量')

    // Click pins a Generation bucket pill -> shows duration, queue wait, and policy_blocked count.
    const genPills = screen.getAllByRole('button', { name: /gpt-image-1\.5/ })
    fireEvent.click(genPills[1]!)
    expect(screen.getByText('生成耗时中位数')).toBeInTheDocument()
    expect(screen.getByText('排队等待中位数')).toBeInTheDocument()
    expect(screen.getByText('内容策略拒图')).toBeInTheDocument()
    expect(screen.getByText('2 次')).toBeInTheDocument()
    fireEvent.click(genPills[1]!)
    expect(screen.queryByText('生成耗时中位数')).not.toBeInTheDocument()

    // Collapse the OpenAI group card.
    const groupToggle = screen.getByRole('button', { name: /OpenAI 兼容生成/ })
    expect(groupToggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(groupToggle)
    expect(groupToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('gpt-image-1.5')).not.toBeInTheDocument()
  })
})
