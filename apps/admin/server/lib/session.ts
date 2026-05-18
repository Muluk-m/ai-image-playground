import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { SESSION_TTL_MS } from './constants'

/**
 * Cookie 格式：`<expires_at_iso>.<hmac-sha256-base64url>`
 * HMAC 输入是 expires_at_iso 文本，secret 来自 ADMIN_COOKIE_SECRET env。
 * 零持久化：cookie 自带过期时间 + 签名，admin server 重启不丢登录。
 */

export function signSession(ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const hmac = createHmac('sha256', config.cookieSecret).update(expiresAt).digest('base64url')
  return `${expiresAt}.${hmac}`
}

export function verifySession(cookieVal: string): {
  valid: boolean
  expiresAt?: Date
} {
  if (!cookieVal || !cookieVal.includes('.')) return { valid: false }
  // ISO 8601 字符串里包含 `.`（毫秒），分隔符必须用最后一个 `.`，不是第一个
  const dotIdx = cookieVal.lastIndexOf('.')
  const iso = cookieVal.slice(0, dotIdx)
  const providedHmac = cookieVal.slice(dotIdx + 1)
  const expectedHmac = createHmac('sha256', config.cookieSecret).update(iso).digest('base64url')

  // timingSafeEqual 要求两 buffer 等长，否则直接失败
  if (providedHmac.length !== expectedHmac.length) return { valid: false }
  const eq = timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac))
  if (!eq) return { valid: false }

  const expiresAt = new Date(iso)
  if (Number.isNaN(expiresAt.getTime())) return { valid: false }
  if (expiresAt.getTime() < Date.now()) return { valid: false }

  return { valid: true, expiresAt }
}
