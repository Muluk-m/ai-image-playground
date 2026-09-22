import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_inspirations_route')
const requests: Array<{ path: string; operator: string | null }> = []

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push({
      path: new URL(request.url).pathname,
      operator: request.headers.get('x-admin-operator'),
    })
    return Response.json({ ok: true })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`

// The server config captures env at module load, after the mock port is known.
const { app } = await import('../../../../server/app')

afterAll(() => {
  mockBff.stop()
})

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

describe('Admin inspiration writes', () => {
  it('attributes forwarded mutations to the authenticated operator', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/inspirations', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'test-item' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(requests).toEqual([{ path: '/internal/admin/inspirations', operator: 'password-admin' }])
  })
})
