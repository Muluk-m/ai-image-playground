import { describe, expect, it } from 'bun:test'
import { createApiMetrics, isCountedPath } from '../../ops/api-metrics'

const MINUTE = 1_789_000_020_000 // 恰好是一分钟的起点
const T0 = MINUTE + 20_000

describe('createApiMetrics', () => {
  it('rolls a minute up into counts, percentiles and the routes that failed', () => {
    const metrics = createApiMetrics('bff-a')
    for (let i = 1; i <= 100; i++) {
      metrics.record({ at: T0, route: 'GET /api/x', status: 200, durationMs: i })
    }
    metrics.record({ at: T0, route: 'POST /v1/submit', status: 502, durationMs: 900 })
    metrics.record({ at: T0, route: 'POST /v1/submit', status: 500, durationMs: 800 })
    metrics.record({ at: T0, route: 'GET /api/y', status: 404, durationMs: 1 })

    const [row] = metrics.drain(T0 + 60_000)

    expect(row).toEqual({
      minute: MINUTE,
      instance: 'bff-a',
      requests: 103,
      client_errors: 1,
      server_errors: 2,
      p50_ms: 51,
      p95_ms: 97,
      max_ms: 900,
      server_error_routes: { 'POST /v1/submit': 2 },
    })
  })

  it('holds the minute still in progress until it is over, unless told to flush everything', () => {
    const metrics = createApiMetrics('bff-a')
    metrics.record({ at: T0, route: 'GET /api/x', status: 200, durationMs: 5 })

    expect(metrics.drain(T0 + 1_000)).toEqual([])
    expect(metrics.drain(T0 + 1_000, true)).toHaveLength(1)
    expect(metrics.drain(T0 + 120_000, true)).toEqual([])
  })

  it('keeps a bounded, uniform sample when a minute is very busy', () => {
    let seed = 1
    const metrics = createApiMetrics('bff-a', () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647
    })
    for (let i = 0; i < 10_000; i++) {
      metrics.record({ at: T0, route: 'GET /api/x', status: 200, durationMs: i % 1000 })
    }
    const [row] = metrics.drain(T0 + 60_000)
    expect(row.requests).toBe(10_000)
    expect(row.max_ms).toBe(999)
    // 均匀分布 0–999 的中位数在 500 附近；抽样只该带来小偏差。
    expect(Math.abs((row.p50_ms ?? 0) - 500)).toBeLessThan(60)
  })
})

describe('isCountedPath', () => {
  it('leaves out health checks and internal endpoints', () => {
    expect(isCountedPath('/health')).toBe(false)
    expect(isCountedPath('/internal/admin/ops/host-samples')).toBe(false)
    expect(isCountedPath('/v1/queue/openai-compat/gpt-image-2/submit')).toBe(true)
  })
})
