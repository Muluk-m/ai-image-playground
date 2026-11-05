import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_gpt_direct_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const requests: Array<{ method: string; path: string; operator: string | null }> = []
const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname + new URL(request.url).search,
      operator: request.headers.get('x-admin-operator'),
    })
    return Response.json({ ok: true, keys: [] })
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

describe('Admin direct-key proxy', () => {
  it('requires a session and forwards restore with the operator', async () => {
    expect((await app.handle(new Request('http://localhost/api/gpt-direct'))).status).toBe(401)
    const cookie = await login()
    requests.length = 0
    const listed = await app.handle(
      new Request('http://localhost/api/gpt-direct?days=30', { headers: { cookie } }),
    )
    expect(listed.status).toBe(200)
    const restored = await app.handle(
      new Request('http://localhost/api/gpt-direct/keys/abcd1234/restore', {
        method: 'POST',
        headers: { cookie },
      }),
    )
    expect(restored.status).toBe(200)
    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/internal/admin/gpt-direct?days=30',
        operator: null,
      },
      {
        method: 'POST',
        path: '/internal/admin/gpt-direct/keys/abcd1234/restore',
        operator: 'password-admin',
      },
    ])
  })
})
