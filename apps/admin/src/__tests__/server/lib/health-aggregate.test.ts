import { describe, expect, it } from 'bun:test'
import {
  buildHealthMonitorSnapshot,
  classifyBucketStatus,
  deriveCurrentStatus,
  HEALTH_THRESHOLDS,
} from '../../../../server/lib/health-aggregate'

describe('health monitor status classification', () => {
  it('classifies buckets by success rate and latency thresholds', () => {
    expect(classifyBucketStatus('agent', { total: 0, succeeded: 0 })).toBe('idle')
    expect(classifyBucketStatus('agent', { total: 100, succeeded: 100, ttft_p50_ms: 1800 })).toBe(
      'healthy',
    )
    expect(classifyBucketStatus('agent', { total: 100, succeeded: 95, ttft_p50_ms: 1200 })).toBe(
      'degraded',
    )
    expect(classifyBucketStatus('agent', { total: 10, succeeded: 7, ttft_p50_ms: 1200 })).toBe(
      'outage',
    )
    expect(
      classifyBucketStatus('agent', {
        total: 50,
        succeeded: 50,
        ttft_p50_ms: HEALTH_THRESHOLDS.AGENT_TTFT_DEGRADED_MS + 1,
      }),
    ).toBe('degraded')
    expect(
      classifyBucketStatus('generation', {
        total: 20,
        succeeded: 20,
        queue_wait_p50_ms: HEALTH_THRESHOLDS.GENERATION_QUEUE_WAIT_DEGRADED_MS + 1,
      }),
    ).toBe('degraded')
    expect(
      classifyBucketStatus('api', {
        total: 500,
        succeeded: 500,
        duration_p95_ms: HEALTH_THRESHOLDS.API_P95_DEGRADED_MS + 1,
      }),
    ).toBe('degraded')
  })

  it('derives current status from the newest active bucket within lookback', () => {
    const empty = {
      start_at: 0,
      end_at: 300_000,
      status: 'idle' as const,
      total: 0,
      succeeded: 0,
      failed: 0,
      success_rate: null,
    }
    expect(
      deriveCurrentStatus([
        { ...empty, status: 'outage', total: 2, succeeded: 0, failed: 2, success_rate: 0 },
        empty,
        empty,
        empty,
      ]),
    ).toBe('idle')
    expect(
      deriveCurrentStatus([
        empty,
        { ...empty, status: 'degraded', total: 10, succeeded: 9, failed: 1, success_rate: 0.9 },
        empty,
      ]),
    ).toBe('degraded')
  })
})

describe('buildHealthMonitorSnapshot', () => {
  const bucketMs = 5 * 60 * 1000
  const now = Math.floor(Date.UTC(2026, 10, 25, 10, 42, 0) / bucketMs) * bucketMs + 120_000
  const latestBucketAt = Math.floor(now / bucketMs) * bucketMs

  const baseInput = {
    range: '6h' as const,
    now,
    generationBuckets: [
      {
        provider: 'openai-compat',
        model: 'gpt-image-1.5',
        gpt_route: 'direct' as const,
        bucket_at: latestBucketAt,
        succeeded: 9,
        system_failed: 0,
        policy_blocked: 1,
        duration_p50_ms: 14_200,
        duration_p95_ms: 21_500,
        queue_wait_p50_ms: 600,
      },
      {
        provider: 'openai-compat',
        model: 'gpt-image-1.5',
        gpt_route: 'sub2api' as const,
        bucket_at: latestBucketAt,
        succeeded: 8,
        system_failed: 2,
        policy_blocked: 0,
        duration_p50_ms: 19_000,
        duration_p95_ms: 30_000,
        queue_wait_p50_ms: 1_200,
      },
    ],
    generationSummaries: [
      {
        provider: 'openai-compat',
        model: 'gpt-image-1.5',
        gpt_route: 'direct' as const,
        succeeded: 9,
        system_failed: 0,
        policy_blocked: 1,
        duration_p50_ms: 14_200,
        duration_p95_ms: 21_500,
        queue_wait_p50_ms: 600,
      },
      {
        provider: 'openai-compat',
        model: 'gpt-image-1.5',
        gpt_route: 'sub2api' as const,
        succeeded: 8,
        system_failed: 2,
        policy_blocked: 0,
        duration_p50_ms: 19_000,
        duration_p95_ms: 30_000,
        queue_wait_p50_ms: 1_200,
      },
    ],
    generationOverallP50Ms: 16_000,
    agentBuckets: [
      {
        model: 'claude-sonnet-4-6',
        bucket_at: latestBucketAt,
        succeeded: 20,
        failed: 0,
        ttft_p50_ms: 1_450,
        ttft_p95_ms: 2_800,
        duration_p50_ms: 6_200,
        duration_p95_ms: 11_000,
      },
    ],
    agentSummaries: [
      {
        model: 'claude-sonnet-4-6',
        succeeded: 20,
        failed: 0,
        ttft_p50_ms: 1_450,
        ttft_p95_ms: 2_800,
        duration_p50_ms: 6_200,
        duration_p95_ms: 11_000,
      },
    ],
    agentOverallTtftP50Ms: 1_450,
    apiBuckets: [
      {
        bucket_at: latestBucketAt,
        requests: 400,
        server_errors: 0,
        p50_ms: 45,
        p95_ms: 280,
      },
    ],
    apiSummary: {
      requests: 400,
      server_errors: 0,
      p50_ms: 45,
      p95_ms: 280,
    },
  }

  it('excludes content_policy rejections by default and splits gpt_route components', () => {
    const snap = buildHealthMonitorSnapshot({ ...baseInput, includePolicy: false })
    expect(snap.bucket_count).toBe(72)
    expect(snap.groups).toHaveLength(3)

    const openaiGroup = snap.groups[0]!
    expect(openaiGroup.name).toBe('OpenAI 兼容生成')
    expect(openaiGroup.components).toHaveLength(2)

    const direct = openaiGroup.components.find((c) => c.badge === 'OpenAI 直连')!
    expect(direct.total).toBe(9)
    expect(direct.failed).toBe(0)
    expect(direct.availability).toBe(1)
    expect(direct.policy_blocked).toBe(1)
    expect(direct.status).toBe('healthy')
    expect(direct.buckets).toHaveLength(72)
    expect(direct.buckets[71]!.policy_blocked).toBe(1)

    const sub2api = openaiGroup.components.find((c) => c.badge === 'sub2api')!
    expect(sub2api.total).toBe(10)
    expect(sub2api.availability).toBe(0.8)
    expect(sub2api.status).toBe('degraded')

    expect(snap.summary.agent_ttft_p50_ms).toBe(1_450)
    expect(snap.summary.generation_p50_ms).toBe(16_000)
    expect(snap.summary.api_p95_ms).toBe(280)
  })

  it('counts content_policy rejections as failures when includePolicy is true', () => {
    const snap = buildHealthMonitorSnapshot({ ...baseInput, includePolicy: true })
    const direct = snap.groups[0]!.components.find((c) => c.badge === 'OpenAI 直连')!
    expect(direct.total).toBe(10)
    expect(direct.failed).toBe(1)
    expect(direct.availability).toBe(0.9)
    expect(direct.status).toBe('degraded')
  })
})
