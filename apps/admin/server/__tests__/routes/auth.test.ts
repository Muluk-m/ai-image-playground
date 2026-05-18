import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-auth.sqlite'
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { app } = await import('../../app')

async function post(path: string, body?: unknown, cookieHeader?: string, ip?: string) {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookieHeader) headers.cookie = cookieHeader
  if (ip) headers['cf-connecting-ip'] = ip
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function get(path: string, cookieHeader?: string, ip?: string) {
  const headers: Record<string, string> = {}
  if (cookieHeader) headers.cookie = cookieHeader
  if (ip) headers['cf-connecting-ip'] = ip
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

// routes/auth.ts module 顶层 limiter 是 singleton（同一文件多 it 共享），所以
// 不同 it 用不同的 cf-connecting-ip 隔离 rate-limit 状态。
describe('POST /api/login', () => {
  it('正确密码 → 200 + Set-Cookie', async () => {
    const res = await post('/api/login', { password: 'test-pass-1234' }, undefined, '10.0.0.1')
    expect(res.status).toBe(200)
    const cookieHeader = res.headers.get('set-cookie') ?? ''
    expect(cookieHeader).toContain('admin_session=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Lax')
  })

  it('错误密码 → 401', async () => {
    const res = await post('/api/login', { password: 'wrong' }, undefined, '10.0.0.2')
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('invalid_password')
  })

  it('5 次连续失败后第 6 次 → 429 locked', async () => {
    const ip = '10.0.0.3'
    // 5 次错：fails 1..5，都 ≤ maxFailures=5，所以全 401
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/login', { password: 'wrong' }, undefined, ip)
      expect(res.status).toBe(401)
    }
    // 第 6 次错：fails=6，justLocked=true → 429
    const res6 = await post('/api/login', { password: 'wrong' }, undefined, ip)
    expect(res6.status).toBe(429)
  })
})

describe('POST /api/logout', () => {
  it('清 cookie', async () => {
    // 先 login
    const loginRes = await post('/api/login', { password: 'test-pass-1234' }, undefined, '10.0.0.4')
    const cookieRaw = loginRes.headers.get('set-cookie')!
    const sessionCookie = cookieRaw.split(';')[0]!
    const logoutRes = await post('/api/logout', undefined, sessionCookie, '10.0.0.4')
    expect(logoutRes.status).toBe(200)
    const clearHeader = logoutRes.headers.get('set-cookie') ?? ''
    // 清 cookie 一般是 Max-Age=0 或过期时间在过去
    expect(clearHeader).toContain('admin_session=')
    expect(/(Max-Age=0|Expires=)/i.test(clearHeader)).toBe(true)
  })
})

describe('GET /api/me', () => {
  it('未登录 → 401', async () => {
    const res = await get('/api/me', undefined, '10.0.0.5')
    expect(res.status).toBe(401)
  })

  it('登录后 → 200 ok', async () => {
    const loginRes = await post('/api/login', { password: 'test-pass-1234' }, undefined, '10.0.0.6')
    const sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!
    const meRes = await get('/api/me', sessionCookie, '10.0.0.6')
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
