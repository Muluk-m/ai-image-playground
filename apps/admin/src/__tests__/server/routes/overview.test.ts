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
])

const { app } = await import('../../app')

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
      failures: Array<{ error_type: string; count: number }>
      models: Array<{ model: string; count: number }>
    }

    expect(body.summary).toMatchObject({
      total: 2,
      completed: 1,
      failed: 1,
      success_rate: 0.5,
      p50_duration_ms: 1000,
      p95_duration_ms: 5000,
    })
    expect(body.volume).toHaveLength(24)
    expect(body.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(2)
    expect(body.failures).toEqual([{ error_type: 'upstream_error', count: 1 }])
    expect(body.models).toEqual([
      { model: 'gemini-3-pro', count: 1 },
      { model: 'gpt-image-2', count: 1 },
    ])
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
    expect(body.summary.total).toBe(3)
    expect(body.volume).toHaveLength(7)
    expect(body.volume.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(3)
  })
})
