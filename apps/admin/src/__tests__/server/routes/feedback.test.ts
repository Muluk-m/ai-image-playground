import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

const databaseUrl = await resetTestDatabase('admin_feedback_route')
const requests: Array<{ method: string; path: string; search: string; operator: string | null }> =
  []

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-feedback'
process.env.PORT = '0'

const mockBff = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    requests.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      operator: request.headers.get('x-admin-operator'),
    })
    if (url.pathname.startsWith('/internal/admin/feedback/attachments/')) {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    }
    return Response.json({ ok: true })
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
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.183' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

describe('Admin feedback proxy routes', () => {
  it('requires admin login and forwards list, reply, status, and attachment requests', async () => {
    expect((await app.handle(new Request('http://localhost/api/feedback'))).status).toBe(401)

    requests.length = 0
    const cookie = await login()

    const list = await app.handle(
      new Request('http://localhost/api/feedback?filter=awaiting_reply&q=导出', {
        headers: { cookie },
      }),
    )
    expect(list.status).toBe(200)

    const reply = await app.handle(
      new Request('http://localhost/api/feedback/thread-1/replies', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ body: '已修复' }),
      }),
    )
    expect(reply.status).toBe(200)

    const statusPatch = await app.handle(
      new Request('http://localhost/api/feedback/thread-1/status', {
        method: 'PATCH',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'resolved', updatedAt: 1_795_000_000_000 }),
      }),
    )
    expect(statusPatch.status).toBe(200)

    const attachment = await app.handle(
      new Request('http://localhost/api/feedback/attachments/msg-1', {
        headers: { cookie },
      }),
    )
    expect(attachment.status).toBe(200)
    expect(attachment.headers.get('content-type')).toBe('image/png')
    expect(attachment.headers.get('x-content-type-options')).toBe('nosniff')

    expect(requests).toEqual([
      {
        method: 'GET',
        path: '/internal/admin/feedback',
        search: '?filter=awaiting_reply&q=%E5%AF%BC%E5%87%BA',
        operator: null,
      },
      {
        method: 'POST',
        path: '/internal/admin/feedback/thread-1/replies',
        search: '',
        operator: 'password-admin',
      },
      {
        method: 'PATCH',
        path: '/internal/admin/feedback/thread-1/status',
        search: '',
        operator: 'password-admin',
      },
      {
        method: 'GET',
        path: '/internal/admin/feedback/attachments/msg-1',
        search: '',
        operator: null,
      },
    ])
  })
})
