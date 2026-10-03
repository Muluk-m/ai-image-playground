import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_overview_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const now = Date.now()
await writer.db.insert(writer.schema.tasks).values([
  {
    id: 'overview-completed',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'completed', device_id: 'overview-device' },
    submitted_at: now - 2 * 3600_000,
    started_at: now - 2 * 3600_000 + 100,
    completed_at: now - 2 * 3600_000 + 1100,
    upstream_invocation_count: 2,
  },
  {
    id: 'overview-failed',
    provider: 'gemini',
    model: 'gemini-3-pro',
    status: 'failed',
    request_payload: { prompt: 'failed', device_id: 'overview-device' },
    error_type: 'upstream_error',
    submitted_at: now - 3 * 3600_000,
    started_at: now - 3 * 3600_000 + 100,
    completed_at: now - 3 * 3600_000 + 5100,
    upstream_invocation_count: 3,
  },
  {
    id: 'overview-older',
    provider: 'openai-compat',
    model: 'gpt-image-1',
    status: 'completed',
    request_payload: { prompt: 'older', device_id: 'overview-device' },
    submitted_at: now - 2 * 24 * 3600_000,
    started_at: now - 2 * 24 * 3600_000 + 100,
    completed_at: now - 2 * 24 * 3600_000 + 2100,
  },
  {
    // 上一个 1 天窗口里的一单：只该出现在环比的 previous 里。
    id: 'overview-previous-day',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'failed',
    request_payload: { prompt: 'previous', device_id: 'previous-device', n: 4 },
    error_type: 'upstream_error',
    submitted_at: now - 30 * 3600_000,
  },
])
await writer.db.insert(writer.schema.users).values({
  id: 'overview-user',
  username: 'overview-user',
  password_hash: 'x',
  created_at: now - 3600_000,
  updated_at: now - 3600_000,
})
await writer.db.insert(writer.schema.agent_conversations).values({
  id: 'overview-conversation',
  user_id: 'overview-user',
  title: 'agent',
  created_at: now - 3600_000,
  updated_at: now - 3600_000,
})
await writer.db.insert(writer.schema.agent_turns).values([
  {
    conversation_id: 'overview-conversation',
    turn_id: 'turn-ok',
    duration_ms: 1000,
    stop_reason: 'completed',
    created_at: now - 3600_000,
  },
  {
    conversation_id: 'overview-conversation',
    turn_id: 'turn-failed',
    duration_ms: 1000,
    stop_reason: 'failed',
    created_at: now - 3500_000,
  },
])

const { app } = await import('../../../../server/app')

afterAll(async () => {
  await writer.close()
})

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.175' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/overview', () => {
  it('requires the admin session', async () => {
    const response = await app.handle(new Request('http://localhost/api/overview?range=1d'))
    expect(response.status).toBe(401)
  })

  it('returns complete time buckets, outcomes, models, failures, and duration percentiles', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/overview?range=1d', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      summary: Record<string, number>
      volume: Array<{ total: number }>
      failures: Array<Record<string, unknown>>
      models: Array<Record<string, unknown>>
    }

    expect(body.summary).toMatchObject({
      total: 2,
      completed: 1,
      failed: 1,
      success_rate: 0.5,
      p50_duration_ms: 1000,
      p95_duration_ms: 5000,
      upstream_invocations: 5,
      queue_p50_ms: 100,
    })
    expect(body.volume).toHaveLength(24)
    expect(body.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2)
    expect(body.failures).toEqual([{ error_type: 'upstream_error', count: 1, previous_count: 1 }])
    expect(body.models).toEqual([
      {
        model: 'gemini-3-pro',
        count: 1,
        upstream_invocations: 3,
        average_multiplier: 3,
        completed: 0,
        failed: 1,
        queue_p50_ms: 100,
        run_p95_ms: null,
      },
      {
        model: 'gpt-image-2',
        count: 1,
        upstream_invocations: 2,
        average_multiplier: 2,
        completed: 1,
        failed: 0,
        queue_p50_ms: 100,
        run_p95_ms: 1000,
      },
    ])
  })

  it('compares the window with the previous one and charts the same buckets', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/overview?range=1d', { headers: { cookie } }),
    )
    const body = (await response.json()) as {
      volume: Array<{ bucket_at: number }>
      pulse: {
        current: Record<string, number>
        previous: Record<string, number>
        series: Array<Record<string, number>>
      }
    }
    expect(body.pulse.current).toEqual({
      tasks: 2,
      completed: 1,
      failed: 1,
      images: 1,
      // 匿名设备与登录账号（经 Agent 轮次）各算一个。
      active: 2,
      signups: 1,
      agent_turns: 2,
      agent_failed: 1,
      agent_aborted: 0,
    })
    expect(body.pulse.previous).toMatchObject({ tasks: 1, failed: 1, images: 0, active: 1 })
    expect(body.pulse.series.map((bucket) => bucket.bucket_at)).toEqual(
      body.volume.map((bucket) => bucket.bucket_at),
    )
    const sum = (key: string) =>
      body.pulse.series.reduce((total, bucket) => total + bucket[key]!, 0)
    expect(sum('tasks')).toBe(2)
    expect(sum('signups')).toBe(1)
    expect(sum('agent_completed') + sum('agent_failed')).toBe(2)
  })

  it('changes the query window and bucket count', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/overview?range=7d', { headers: { cookie } }),
    )
    const body = (await response.json()) as {
      summary: { total: number }
      volume: Array<{ total: number }>
    }
    expect(body.summary.total).toBe(4)
    expect(body.volume).toHaveLength(7)
    expect(body.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(4)
  })
})
