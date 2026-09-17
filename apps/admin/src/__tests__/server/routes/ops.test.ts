import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import type { OpsSnapshot } from '../../../../contracts'

const databaseUrl = await resetTestDatabase('admin_ops_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const now = Date.now()
const minute = 60_000
const base = {
  provider: 'openai-compat',
  model: 'gpt-image-2',
  request_payload: { prompt: 'x', device_id: 'ops-device' },
} as const

await writer.db.insert(writer.schema.tasks).values([
  { ...base, id: 'ops-queued-old', status: 'queued', submitted_at: now - 12 * minute },
  { ...base, id: 'ops-queued-new', status: 'queued', submitted_at: now - 1 * minute },
  {
    ...base,
    id: 'ops-running',
    status: 'in_progress',
    submitted_at: now - 3 * minute,
    started_at: now - 2 * minute,
  },
  {
    ...base,
    id: 'ops-stuck',
    status: 'in_progress',
    submitted_at: now - 40 * minute,
    started_at: now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS - minute,
  },
  {
    ...base,
    id: 'ops-done',
    status: 'completed',
    submitted_at: now - 50 * minute,
    started_at: now - 50 * minute,
    completed_at: now - 49 * minute,
  },
  // 对话轮也是 tasks 里的一行，但不属于生成队列，看板的队列一栏不数它。
  { ...base, id: 'ops-chat-turn', kind: 'chat', status: 'queued', submitted_at: now - 30 * minute },
])

const { app } = await import('../../../../server/app')

afterAll(async () => {
  await writer.close()
})

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.176' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/ops', () => {
  it('requires the admin session', async () => {
    const response = await app.handle(new Request('http://localhost/api/ops'))
    expect(response.status).toBe(401)
  })

  it('reports the queue as the worker sees it: counts, the oldest wait, and what is stuck', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as OpsSnapshot

    if (!body.queue.ok) throw new Error(body.queue.error)
    const queue = body.queue.data
    expect(queue.queued).toBe(2)
    expect(queue.in_progress).toBe(2)
    expect(queue.oldest_queued_wait_ms).toBeGreaterThanOrEqual(12 * minute)
    expect(queue.oldest_queued_wait_ms).toBeLessThan(13 * minute)
    // 「卡住」与 worker 回收无主任务用的是同一个阈值，不另立标准。
    expect(queue.stale_after_ms).toBe(QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS)
    expect(queue.stuck.map((task) => task.id)).toEqual(['ops-stuck'])
  })

  it('reports how big the database is and which tables hold the most', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/ops', { headers: { cookie } }),
    )
    const body = (await response.json()) as OpsSnapshot

    if (!body.database.ok) throw new Error(body.database.error)
    expect(body.database.data.size_bytes).toBeGreaterThan(0)
    expect(body.database.data.tables.length).toBeGreaterThan(0)
    expect(body.database.data.tables.map((table) => table.name)).toContain('tasks')
    const sizes = body.database.data.tables.map((table) => table.bytes)
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a))
  })
})
