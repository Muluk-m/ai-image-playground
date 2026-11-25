import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
import type { HealthMonitorSnapshot } from '../../../../contracts'

const databaseUrl = await resetTestDatabase('admin_health_monitor_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const [clock] =
  await writer.client`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000) AS now_ms`
const now = Number(clock.now_ms)
const minute = 60_000

await insertTestTasks(writer.db, [
  {
    id: 'hm-gpt-direct-ok',
    provider: 'openai-compat',
    model: 'gpt-image-1.5',
    gpt_route: 'direct',
    status: 'completed',
    submitted_at: now - 4 * minute,
    started_at: now - 4 * minute + 800,
    completed_at: now - 4 * minute + 12_800,
    request_payload: { prompt: 'ok', device_id: 'hm-dev' },
  },
  {
    id: 'hm-gpt-direct-policy',
    provider: 'openai-compat',
    model: 'gpt-image-1.5',
    gpt_route: 'direct',
    status: 'failed',
    error_type: 'content_policy',
    submitted_at: now - 3 * minute,
    started_at: now - 3 * minute + 500,
    completed_at: now - 3 * minute + 3_500,
    request_payload: { prompt: 'policy', device_id: 'hm-dev' },
  },
  {
    id: 'hm-gpt-sub2api-fail',
    provider: 'openai-compat',
    model: 'gpt-image-1.5',
    gpt_route: 'sub2api',
    status: 'failed',
    error_type: 'upstream_error',
    submitted_at: now - 2 * minute,
    started_at: now - 2 * minute + 1_000,
    completed_at: now - 2 * minute + 9_000,
    request_payload: { prompt: 'fail', device_id: 'hm-dev' },
  },
])

await writer.db.insert(writer.schema.agent_conversations).values({
  id: 'hm-conv',
  device_id: 'hm-dev',
  title: 'health check',
  created_at: now - 5 * minute,
  updated_at: now - minute,
})

await writer.db.insert(writer.schema.agent_model_calls).values([
  {
    id: 'hm-call-ok',
    conversation_id: 'hm-conv',
    turn_id: 't-1',
    device_id: 'hm-dev',
    purpose: 'conversation',
    model: 'claude-sonnet-4-6',
    status: 'completed',
    http_dispatch_count: 1,
    ttft_ms: 1_650,
    started_at: now - 3 * minute,
    finished_at: now - 3 * minute + 5_200,
  },
  {
    id: 'hm-call-rejected',
    conversation_id: 'hm-conv',
    turn_id: 't-2',
    device_id: 'hm-dev',
    purpose: 'conversation',
    model: 'claude-sonnet-4-6',
    status: 'failed',
    http_dispatch_count: 0,
    local_rejection: 'request_bytes',
    started_at: now - 2 * minute,
    finished_at: now - 2 * minute + 10,
  },
])

await writer.db.insert(writer.schema.api_minutes).values({
  minute: Math.floor((now - 2 * minute) / minute) * minute,
  instance: 'bff-1',
  requests: 200,
  client_errors: 2,
  server_errors: 0,
  p50_ms: 42,
  p95_ms: 230,
  max_ms: 410,
})

const { app } = await import('../../../../server/app')
const { getDbHandle } = await import('../../../../server/lib/db')

async function loginCookie(): Promise<string> {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    }),
  )
  expect(res.status).toBe(200)
  return res.headers.get('set-cookie')!.split(';')[0]!
}

afterAll(async () => {
  await getDbHandle().close()
  await writer.close()
})

describe('GET /api/ops/health', () => {
  it('requires admin authentication', async () => {
    const res = await app.handle(new Request('http://localhost/api/ops/health'))
    expect(res.status).toBe(401)
  })

  it('aggregates generation tasks, agent TTFT, and api_minutes with policy toggle', async () => {
    const cookie = await loginCookie()

    const defaultRes = await app.handle(
      new Request('http://localhost/api/ops/health?range=6h', {
        headers: { cookie },
      }),
    )
    expect(defaultRes.status).toBe(200)
    const snap = (await defaultRes.json()) as HealthMonitorSnapshot
    expect(snap.range).toBe('6h')
    expect(snap.include_policy).toBe(false)
    expect(snap.bucket_count).toBe(72)

    const openaiGroup = snap.groups.find((g) => g.id === 'generation:openai-compat')!
    expect(openaiGroup).toBeDefined()
    const direct = openaiGroup.components.find((c) => c.badge === 'OpenAI 直连')!
    expect(direct.total).toBe(1)
    expect(direct.succeeded).toBe(1)
    expect(direct.failed).toBe(0)
    expect(direct.policy_blocked).toBe(1)
    expect(direct.duration_p50_ms).toBe(12_000)

    const agentGroup = snap.groups.find((g) => g.id === 'agent:models')!
    expect(agentGroup.components).toHaveLength(1)
    expect(agentGroup.components[0]!.name).toBe('claude-sonnet-4-6')
    // local_rejection must not be counted as an upstream model failure
    expect(agentGroup.components[0]!.total).toBe(1)
    expect(agentGroup.components[0]!.ttft_p50_ms).toBe(1_650)
    expect(snap.summary.agent_ttft_p50_ms).toBe(1_650)

    const apiGroup = snap.groups.find((g) => g.id === 'api:core')!
    expect(apiGroup.total).toBe(200)
    expect(apiGroup.availability).toBe(1)
    expect(snap.summary.api_p95_ms).toBe(230)

    // includePolicy=1 counts content_policy rejection as a failure
    const policyRes = await app.handle(
      new Request('http://localhost/api/ops/health?range=24h&includePolicy=1', {
        headers: { cookie },
      }),
    )
    expect(policyRes.status).toBe(200)
    const policySnap = (await policyRes.json()) as HealthMonitorSnapshot
    expect(policySnap.range).toBe('24h')
    expect(policySnap.bucket_count).toBe(96)
    expect(policySnap.include_policy).toBe(true)
    const directWithPolicy = policySnap.groups
      .find((g) => g.id === 'generation:openai-compat')!
      .components.find((c) => c.badge === 'OpenAI 直连')!
    expect(directWithPolicy.total).toBe(2)
    expect(directWithPolicy.failed).toBe(1)
    expect(directWithPolicy.availability).toBe(0.5)
  })
})
