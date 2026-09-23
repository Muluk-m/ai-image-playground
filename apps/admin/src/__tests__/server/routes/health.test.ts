import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const { app } = await import('../../../../server/app')

describe('GET /health', () => {
  it('reports the immutable release version', async () => {
    process.env.APP_VERSION = 'public-sha+private-sha'
    const res = await app.handle(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, version: 'public-sha+private-sha' })
  })
})
