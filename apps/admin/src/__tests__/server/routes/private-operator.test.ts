import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.ADMIN_PASSWORD = 'test-password'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = await resetTestDatabase('admin_private_operator')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const requests: Array<{ operator: string | null; authorization: string | null }> = []
const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push({
      operator: request.headers.get('x-admin-operator'),
      authorization: request.headers.get('authorization'),
    })
    return Response.json({ ok: true })
  },
})
process.env.BFF_INTERNAL_URL = `http://127.0.0.1:${mockBff.port}`
const { app } = await import('../../../../server/app')
const { signSession } = await import('../../../../server/lib/session')
const { SESSION_COOKIE_NAME } = await import('../../../../server/lib/constants')
afterAll(() => mockBff.stop())

function write(cookie?: string) {
  return app.handle(
    new Request('http://localhost/api/private/billing/settings', {
      method: 'PUT',
      headers: {
        ...(cookie ? { cookie } : {}),
        'content-type': 'application/json',
        'x-admin-operator': 'forged@example.com',
        authorization: 'Bearer forged-service-token',
      },
      body: JSON.stringify({ guidance: 'test' }),
    }),
  )
}

describe('private operation attribution', () => {
  it('does not forward unauthenticated requests even with an actor header', async () => {
    requests.length = 0
    expect((await write()).status).toBe(401)
    expect(requests).toEqual([])
  })

  it('replaces browser-supplied identity with the verified session identity', async () => {
    for (const operator of ['operator@example.com', 'password-admin']) {
      requests.length = 0
      const cookie = `${SESSION_COOKIE_NAME}=${signSession(operator)}`
      expect((await write(cookie)).status).toBe(200)
      expect(requests).toEqual([
        { operator, authorization: 'Bearer fixture-service-credential-alpha' },
      ])
    }
  })
})
