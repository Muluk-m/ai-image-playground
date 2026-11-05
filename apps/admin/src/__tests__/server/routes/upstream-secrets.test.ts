import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_upstream_secrets_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'
const secret = 'test-admin-proxy-secret'
const requests: Array<{ method: string; path: string; operator: string | null; body: string }> = []
const mockBff = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.text()
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      operator: request.headers.get('x-admin-operator'),
      body,
    })
    if (request.method === 'POST') return Response.json({ ok: false, httpStatus: 401 })
    return Response.json({
      writable: true,
      disabledReason: null,
      warning: null,
      secrets: [
        {
          id: 'openai_direct',
          label: 'OpenAI 直连',
          configured: true,
          source: 'admin',
          updatedAt: 1,
          updatedBy: 'password-admin',
        },
      ],
    })
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

describe('Admin upstream secrets proxy', () => {
  it('requires an admin session and does not echo the key it forwards', async () => {
    expect((await app.handle(new Request('http://localhost/api/upstream-secrets'))).status).toBe(
      401,
    )
    const cookie = await login()
    requests.length = 0
    const saved = await app.handle(
      new Request('http://localhost/api/upstream-secrets/openai_direct', {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: secret }),
      }),
    )
    expect(saved.status).toBe(200)
    const savedText = await saved.text()
    expect(savedText).not.toContain(secret)
    expect(requests[0]).toEqual({
      method: 'PUT',
      path: '/internal/admin/upstream-secrets/openai_direct',
      operator: 'password-admin',
      body: JSON.stringify({ apiKey: secret }),
    })

    const probe = await app.handle(
      new Request('http://localhost/api/upstream-secrets/gemini/test', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: secret }),
      }),
    )
    expect(await probe.json()).toEqual({ ok: false, httpStatus: 401 })
    expect(requests[1]?.path).toBe('/internal/admin/upstream-secrets/gemini/test')
    expect(requests[1]?.operator).toBeNull()
  })
})
