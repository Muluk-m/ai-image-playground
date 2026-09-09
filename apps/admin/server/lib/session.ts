import { signToken, verifyToken } from '@image-playground/node-kit'
import type { Cookie } from 'elysia'
import { config } from '../config'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './constants'

/**
 * Cookie 格式：`<expires_at_iso>.<hmac-sha256-base64url>`，payload 明文入 token（`text` 编码），
 * 换掉它会让在外流通的 cookie 全部失效。
 * 零持久化：cookie 自带过期时间 + 签名，admin server 重启不丢登录。
 */

export function signSession(ttlMs: number = SESSION_TTL_MS): string {
  return signToken(config.cookieSecret, new Date(Date.now() + ttlMs).toISOString(), 'text')
}

export function verifySession(cookieVal: string): {
  valid: boolean
  expiresAt?: Date
} {
  const iso = verifyToken(config.cookieSecret, cookieVal, 'text')
  if (iso === null) return { valid: false }

  const expiresAt = new Date(iso)
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) return { valid: false }
  return { valid: true, expiresAt }
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

type CookieJar = Record<string, Cookie<unknown>>

export function setSessionCookie(cookie: CookieJar): void {
  cookie[SESSION_COOKIE_NAME]!.set({
    ...SESSION_COOKIE_OPTIONS,
    value: signSession(),
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function clearSessionCookie(cookie: CookieJar): void {
  cookie[SESSION_COOKIE_NAME]!.set({ ...SESSION_COOKIE_OPTIONS, value: '', maxAge: 0 })
}
