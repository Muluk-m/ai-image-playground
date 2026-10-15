import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_agent_models_route')
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

describe('Admin agent model configuration', () => {
  it('protects model configuration reads behind admin login', async () => {
    const denied = await app.handle(new Request('http://localhost/api/agent-models'))
    expect(denied.status).toBe(401)

    requests.length = 0
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/agent-models', { headers: { cookie } }),
    )
    expect(response.status).toBe(200)
    expect(requests).toEqual([{ path: '/internal/admin/agent-models', operator: null }])
  })

  it('attributes forwarded mutations to the authenticated operator', async () => {
    requests.length = 0
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/agent-models', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 0, settings: { providers: [], profiles: {} } }),
      }),
    )

    expect(response.status).toBe(200)
    expect(requests).toEqual([{ path: '/internal/admin/agent-models', operator: 'password-admin' }])
  })
})
