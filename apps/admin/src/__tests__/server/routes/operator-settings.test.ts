import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_operator_settings_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'
const requests: Array<{ method: string; path: string; operator: string | null; body: string }> = []
const mockBff = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      operator: request.headers.get('x-admin-operator'),
      body: await request.text(),
    })
    return Response.json({ revision: 0, settings: [] })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`
const { app } = await import('../../../../server/app')

afterAll(() => mockBff.stop())

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.182' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('Admin operator settings proxy', () => {
  it('requires auth and forwards operator identity on writes', async () => {
    expect((await app.handle(new Request('http://localhost/api/operator-settings'))).status).toBe(
      401,
    )
    requests.length = 0
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/operator-settings/agent%3Achat', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ value: true, reason: 'enable for incident', expectedRevision: 0 }),
      }),
    )
    expect(response.status).toBe(200)
    expect(requests).toEqual([
      {
        method: 'PUT',
        path: '/internal/admin/operator-config/agent%3Achat',
        operator: 'password-admin',
        body: JSON.stringify({ value: true, reason: 'enable for incident', expectedRevision: 0 }),
      },
    ])
  })
})
