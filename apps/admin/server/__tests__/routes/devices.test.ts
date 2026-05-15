import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-routes.sqlite'
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
    id: 'task-A1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-A-route' } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

const { app } = await import('../../app')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.100' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/devices', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/devices'))
    expect(res.status).toBe(401)
  })

  it('登录后返回 devices 列表', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices?range=7d&sort=last_seen', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Array<{ device_id: string }>; truncated: boolean }
    expect(body.devices.map((d) => d.device_id)).toContain('dev-A-route')
    expect(body.truncated).toBe(false)
  })
})

describe('GET /api/devices/:id', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/devices/dev-A-route'))
    expect(res.status).toBe(401)
  })

  it('已知设备返回详情', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices/dev-A-route?range=7d', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { device_id: string }; tasks: unknown[] }
    expect(body.device.device_id).toBe('dev-A-route')
    expect(body.tasks.length).toBeGreaterThan(0)
  })

  it('未知设备 → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices/nope?range=7d', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})
