import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-tasks.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'task-T1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-T' } as never,
    result_payload: { data: [{ b64_json: 'AAAA' }] } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

const { app } = await import('../../app')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.101' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/tasks/:id', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/tasks/task-T1'))
    expect(res.status).toBe(401)
  })

  it('已知 task：返回 result_meta，剔除 result_payload', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/task-T1', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe('task-T1')
    expect(body.result_payload).toBeUndefined()
    const meta = body.result_meta as { images: unknown[] }
    expect(meta.images.length).toBe(1)
    // device_id 是 VIRTUAL 列：由 request_payload.device_id（'dev-T'）派生
    expect(body.device_id).toBe('dev-T')
  })

  it('未知 task → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})
