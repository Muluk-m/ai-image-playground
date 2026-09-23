import { signPayload, verifyPayload } from '@image-playground/node-kit'
import type { Cookie } from 'elysia'
import { config } from '../config'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from './constants'

interface AdminSessionPayload {
  valid: boolean
  expiresAt?: Date
  operatorId?: string
}

export function signSession(operatorId: string, ttlMs: number = SESSION_TTL_MS): string {
  return signPayload(config.cookieSecret, { operatorId }, { ttlMs })
}

export function verifySession(cookieVal: string): AdminSessionPayload {
  const payload = verifyPayload(config.cookieSecret, cookieVal)
  if (!payload) return { valid: false }
  const { exp, operatorId } = payload
  if (
    typeof exp !== 'number' ||
    typeof operatorId !== 'string' ||
    !operatorId.trim() ||
    operatorId.length > 320
  ) {
    return { valid: false }
  }
  return { valid: true, expiresAt: new Date(exp), operatorId }
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

type CookieJar = Record<string, Cookie<unknown>>

export function setSessionCookie(cookie: CookieJar, operatorId: string): void {
  cookie[SESSION_COOKIE_NAME]!.set({
    ...SESSION_COOKIE_OPTIONS,
    value: signSession(operatorId),
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function clearSessionCookie(cookie: CookieJar): void {
  cookie[SESSION_COOKIE_NAME]!.set({ ...SESSION_COOKIE_OPTIONS, value: '', maxAge: 0 })
}
