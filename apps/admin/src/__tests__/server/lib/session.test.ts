import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const {
  issueAdminSession,
  refreshAdminSession,
  signSession,
  verifySession,
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
} = await import('../../../../server/lib/session')

describe('signSession / verifySession', () => {
  it('签发的 cookie 立即能验证并保留运营者身份', () => {
    const cookie = signSession('operator@example.com')
    const { valid, expiresAt, operatorId } = verifySession(cookie)
    expect(valid).toBe(true)
    expect(operatorId).toBe('operator@example.com')
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('过期的 cookie 验证失败', () => {
    const cookie = signSession('operator@example.com', -1)
    const { valid } = verifySession(cookie)
    expect(valid).toBe(false)
  })

  it('篡改 payload 验证失败', () => {
    const cookie = signSession('operator@example.com')
    const [payload, hmac] = cookie.split('.')
    const tamperedPayload = `${payload?.startsWith('A') ? 'B' : 'A'}${payload?.slice(1)}`
    const { valid } = verifySession(`${tamperedPayload}.${hmac}`)
    expect(valid).toBe(false)
  })

  it('篡改 hmac 验证失败', () => {
    const cookie = signSession('operator@example.com')
    const [iso] = cookie.split('.')
    const tampered = `${iso}.evil-hmac-aaaaaa`
    const { valid } = verifySession(tampered)
    expect(valid).toBe(false)
  })

  it('空字符串 / 格式错误验证失败', () => {
    expect(verifySession('').valid).toBe(false)
    expect(verifySession('no-dot').valid).toBe(false)
  })

  it('issues a short access token and a longer refresh token with an absolute cap', () => {
    const now = Date.now()
    const issued = issueAdminSession('operator@example.com', now)
    expect(verifySession(issued.accessToken).operatorId).toBe('operator@example.com')
    expect(issued.accessExpiresAt).toBe(now + ACCESS_TTL_MS)
    expect(issued.refreshExpiresAt).toBe(now + REFRESH_TTL_MS)

    const renewed = refreshAdminSession(issued.refreshToken, now + 10 * 60_000)
    expect(renewed?.accessExpiresAt).toBe(now + 10 * 60_000 + ACCESS_TTL_MS)
    expect(renewed?.refreshExpiresAt).toBe(now + 10 * 60_000 + REFRESH_TTL_MS)
    expect(refreshAdminSession(issued.refreshToken, now + SESSION_ABSOLUTE_TTL_MS)).toBeNull()
  })

  it('does not accept an access token in the refresh slot', () => {
    expect(refreshAdminSession(signSession('operator@example.com'))).toBeNull()
  })
})
