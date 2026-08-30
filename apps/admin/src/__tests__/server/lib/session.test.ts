import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.PORT = '0'

const { signSession, verifySession } = await import('../../../../server/lib/session')

describe('signSession / verifySession', () => {
  it('签发的 cookie 立即能验证', () => {
    const cookie = signSession()
    const { valid, expiresAt } = verifySession(cookie)
    expect(valid).toBe(true)
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('过期的 cookie 验证失败', () => {
    const cookie = signSession(-1)
    const { valid } = verifySession(cookie)
    expect(valid).toBe(false)
  })

  it('篡改 expires_at 验证失败', () => {
    const cookie = signSession()
    const [_iso, hmac] = cookie.split('.')
    const tampered = `2099-01-01T00:00:00.000Z.${hmac}`
    const { valid } = verifySession(tampered)
    expect(valid).toBe(false)
  })

  it('篡改 hmac 验证失败', () => {
    const cookie = signSession()
    const [iso] = cookie.split('.')
    const tampered = `${iso}.evil-hmac-aaaaaa`
    const { valid } = verifySession(tampered)
    expect(valid).toBe(false)
  })

  it('空字符串 / 格式错误验证失败', () => {
    expect(verifySession('').valid).toBe(false)
    expect(verifySession('no-dot').valid).toBe(false)
  })
})
