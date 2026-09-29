import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'
import { apiErrorHandler } from '../../lib/api-errors'
import { REQUEST_ID_HEADER, requestLogFields, withRequestContext } from '../../lib/request-context'

function appWith(logged: unknown[]) {
  const routes = new Elysia()
    .get('/api/boom', function boom() {
      throw new Error('duplicate key value violates unique constraint "users_email_key"')
    })
    .post('/api/echo', ({ body }) => body, { body: t.Object({ a: t.String() }) })
    .get('/api/taken', ({ status }) => status(409, { error: 'taken' }))
  return new Elysia()
    .use(apiErrorHandler((entry) => logged.push(entry)))
    .use(routes)
    .onError(({ request }) => {
      if (!new URL(request.url).pathname.startsWith('/api/')) return new Response('spa')
    })
}

describe('API error handler', () => {
  it('answers an unexpected throw with a generic 500 and logs the real error', async () => {
    const logged: unknown[] = []
    const res = await appWith(logged).handle(new Request('http://localhost/api/boom'))
    expect(res.status).toBe(500)
    const text = await res.text()
    expect(text).not.toContain('users_email_key')
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' })
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatchObject({ method: 'GET', path: '/api/boom' })
  })

  it('logs the error with the same request id the response carries', async () => {
    const fields: unknown[] = []
    const routes = new Elysia().get('/api/boom', function boom() {
      throw new Error('boom')
    })
    // 与 index.ts 一样：整个请求套在 request context 里，日志的 mixin 在记录这一刻取字段。
    const app = new Elysia().use(apiErrorHandler(() => fields.push(requestLogFields()))).use(routes)
    const handle = withRequestContext((request) => app.fetch(request))

    const res = await handle(new Request('http://localhost/api/boom'))

    expect(res.status).toBe(500)
    expect(fields).toEqual([{ requestId: res.headers.get(REQUEST_ID_HEADER) }])
  })

  it('leaves validation errors, explicit statuses and the SPA fallback alone', async () => {
    const logged: unknown[] = []
    const app = appWith(logged)
    const invalid = await app.handle(
      new Request('http://localhost/api/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    )
    expect(invalid.status).toBe(422)
    expect((await app.handle(new Request('http://localhost/api/taken'))).status).toBe(409)
    const page = await app.handle(new Request('http://localhost/projects/abc'))
    expect(await page.text()).toBe('spa')
    expect(logged).toHaveLength(0)
  })
})
