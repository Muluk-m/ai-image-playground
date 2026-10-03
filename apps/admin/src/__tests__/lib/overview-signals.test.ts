import { describe, expect, it } from 'vitest'

import { attentionItems, change, healthTiles } from '../../lib/overview-signals'
import type { OpsSnapshot, OverviewResult } from '../../lib/types'

const window = {
  tasks: 100,
  completed: 90,
  failed: 10,
  images: 120,
  active: 30,
  signups: 3,
  agent_turns: 20,
  agent_failed: 1,
  agent_aborted: 2,
}

function overview(patch: Partial<OverviewResult> = {}): OverviewResult {
  return {
    summary: {
      total: 100,
      completed: 90,
      failed: 10,
      success_rate: 0.9,
      p50_duration_ms: 1000,
      p95_duration_ms: 5000,
      upstream_invocations: 100,
      queue_p50_ms: 200,
    },
    volume: [],
    volume_bucket: 'day',
    failures: [],
    pulse: { current: window, previous: window, series: [] },
    agent_cache: {
      calls: 0,
      input_tokens: 0,
      cache_read_tokens: 0,
      first_call: { calls: 0, input_tokens: 0, cache_read_tokens: 0 },
      continuation: { calls: 0, input_tokens: 0, cache_read_tokens: 0 },
      models: [],
    },
    models: [],
    ...patch,
  }
}

const unavailable = { ok: false as const, error: 'unavailable' }
function ops(patch: Partial<OpsSnapshot> = {}): OpsSnapshot {
  return {
    generated_at: Date.now(),
    host: unavailable,
    services: unavailable,
    queue: unavailable,
    database: unavailable,
    backup: unavailable,
    containers: unavailable,
    api: unavailable,
    reliability: unavailable,
    deployments: unavailable,
    ...patch,
  }
}

describe('change', () => {
  it('reads direction and sentiment against the previous window', () => {
    expect(change(150, 100)).toEqual({ text: '+50.0%', sentiment: 'good' })
    expect(change(80, 100)).toEqual({ text: '−20.0%', sentiment: 'bad' })
    expect(change(80, 100, false)).toEqual({ text: '−20.0%', sentiment: 'good' })
    expect(change(5, 0).sentiment).toBe('neutral')
    expect(change(100, 100).text).toBe('持平')
  })
})

describe('healthTiles', () => {
  it('flags a generation success drop and the ops queue rule', () => {
    const tiles = healthTiles({
      overview: overview({
        pulse: {
          current: { ...window, completed: 70, failed: 30 },
          previous: window,
          series: [],
        },
      }),
      ops: ops({
        queue: {
          ok: true,
          data: {
            queued: 3,
            in_progress: 1,
            oldest_queued_wait_ms: 20 * 60_000,
            stale_after_ms: 30 * 60_000,
            stuck: [],
          },
        },
      }),
    })
    const byKey = Object.fromEntries(tiles.map((tile) => [tile.key, tile]))
    expect(byKey.generation).toMatchObject({ value: '70.0%', tone: 'warn' })
    expect(byKey.queue).toMatchObject({ tone: 'bad', to: '/ops' })
    expect(byKey.queue!.note).toContain('最老的排队任务已经等了')
    expect(byKey.api).toMatchObject({ value: '取不到', tone: 'unknown' })
    expect(byKey.frontend).toMatchObject({ tone: 'unknown' })
  })
})

describe('attentionItems', () => {
  it('singles out a model failing far above the site and a doubled failure reason', () => {
    const items = attentionItems({
      overview: overview({
        models: [
          {
            model: 'good',
            count: 200,
            upstream_invocations: 200,
            average_multiplier: 1,
            completed: 198,
            failed: 2,
            queue_p50_ms: null,
            run_p95_ms: null,
          },
          {
            model: 'flaky',
            count: 40,
            upstream_invocations: 40,
            average_multiplier: 1,
            completed: 28,
            failed: 12,
            queue_p50_ms: null,
            run_p95_ms: null,
          },
        ],
        failures: [
          { error_type: 'upstream_error', count: 12, previous_count: 3 },
          { error_type: 'moderation', count: 2, previous_count: 0 },
        ],
      }),
    })
    expect(items.map((item) => item.title)).toEqual([
      'flaky 失败率 30.0%',
      'upstream_error 失败比上期多 9 次',
    ])
  })
})
