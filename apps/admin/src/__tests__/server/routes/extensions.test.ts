import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_extensions_route')
const requestedPaths: string[] = []
const requestedAuthorization: Array<string | null> = []
let mockBff: ReturnType<typeof Bun.serve>

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

// Start the mock before config captures BFF_INTERNAL_URL.
mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    requestedPaths.push(new URL(request.url).pathname)
    requestedAuthorization.push(request.headers.get('authorization'))
    return Response.json({
      navigation: [{ label: '计费设置', href: '/billing/settings' }],
      user_links: [{ label: '积分与套餐', href_template: '/users/{userId}' }],
    })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`

const { app } = await import('../../../../server/app')

afterAll(() => {
  mockBff.stop()
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

describe('GET /api/extensions', () => {
  it('requires the Admin session', async () => {
    const response = await app.handle(new Request('http://localhost/api/extensions'))
    expect(response.status).toBe(401)
  })

  it('forwards the BFF extension manifest through service authentication', async () => {
    const cookie = await login()
    const response = await app.handle(
      new Request('http://localhost/api/extensions', { headers: { cookie } }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      navigation: [{ label: '计费设置', href: '/billing/settings' }],
      user_links: [{ label: '积分与套餐', href_template: '/users/{userId}' }],
    })
    expect(requestedPaths).toEqual(['/internal/admin/extensions'])
    expect(requestedAuthorization).toEqual(['Bearer fixture-service-credential-alpha'])
  })
})
