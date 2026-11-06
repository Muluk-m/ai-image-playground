import { randomUUID } from 'node:crypto'
import { signPayload, verifyPayload } from '@image-playground/node-kit'
import type { Cookie } from 'elysia'
import { config } from '../config'
import {
  ACCESS_TTL_MS,
  REFRESH_COOKIE_NAME,
  REFRESH_TTL_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
} from './constants'

interface AdminSessionPayload {
  valid: boolean
  expiresAt?: Date
  operatorId?: string
}

interface IssuedAdminSession {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
}

export { ACCESS_TTL_MS, REFRESH_COOKIE_NAME, REFRESH_TTL_MS, SESSION_ABSOLUTE_TTL_MS }

export function signSession(operatorId: string, ttlMs: number = SESSION_TTL_MS): string {
  return signPayload(config.cookieSecret, { kind: 'access', operatorId }, { ttlMs })
}

export function verifySession(cookieVal: string): AdminSessionPayload {
  const payload = verifyPayload(config.cookieSecret, cookieVal)
  // Accept the pre-refresh cookie shape until its original expiry; new cookies carry an explicit
  // kind so a refresh token can never be used as an access token.
  if (!payload || (payload.kind !== undefined && payload.kind !== 'access')) {
    return { valid: false }
  }
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

export function issueAdminSession(
  operatorId: string,
  now = Date.now(),
  sessionStartedAt = now,
): IssuedAdminSession {
  const refreshExpiresAt = Math.min(
    now + REFRESH_TTL_MS,
    sessionStartedAt + SESSION_ABSOLUTE_TTL_MS,
  )
  return {
    accessToken: signPayload(
      config.cookieSecret,
      { kind: 'access', operatorId, sessionId: randomUUID() },
      { ttlMs: ACCESS_TTL_MS, now },
    ),
    refreshToken: signPayload(
      config.cookieSecret,
      { kind: 'refresh', operatorId, sessionId: randomUUID(), sessionStartedAt },
      { ttlMs: refreshExpiresAt - now, now },
    ),
    accessExpiresAt: now + ACCESS_TTL_MS,
    refreshExpiresAt,
  }
}

export function refreshAdminSession(
  refreshToken: string,
  now = Date.now(),
): IssuedAdminSession | null {
  const payload = verifyPayload(config.cookieSecret, refreshToken, { now })
  if (
    !payload ||
    payload.kind !== 'refresh' ||
    typeof payload.operatorId !== 'string' ||
    !payload.operatorId.trim() ||
    typeof payload.sessionStartedAt !== 'number' ||
    !Number.isSafeInteger(payload.sessionStartedAt) ||
    now >= payload.sessionStartedAt + SESSION_ABSOLUTE_TTL_MS
  ) {
    return null
  }
  return issueAdminSession(payload.operatorId, now, payload.sessionStartedAt)
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

const REFRESH_COOKIE_OPTIONS = {
  ...SESSION_COOKIE_OPTIONS,
  path: '/api/auth',
} as const

type CookieJar = Record<string, Cookie<unknown>>

export function setSessionCookies(cookie: CookieJar, issued: IssuedAdminSession): void {
  const now = Date.now()
  cookie[SESSION_COOKIE_NAME]!.set({
    ...SESSION_COOKIE_OPTIONS,
    value: issued.accessToken,
    maxAge: Math.max(0, Math.ceil((issued.accessExpiresAt - now) / 1000)),
  })
  cookie[REFRESH_COOKIE_NAME]!.set({
    ...REFRESH_COOKIE_OPTIONS,
    value: issued.refreshToken,
    maxAge: Math.max(0, Math.ceil((issued.refreshExpiresAt - now) / 1000)),
  })
}

export function setSessionCookie(cookie: CookieJar, operatorId: string): void {
  setSessionCookies(cookie, issueAdminSession(operatorId))
}

export function clearSessionCookie(cookie: CookieJar): void {
  cookie[SESSION_COOKIE_NAME]!.set({ ...SESSION_COOKIE_OPTIONS, value: '', maxAge: 0 })
  cookie[REFRESH_COOKIE_NAME]!.set({ ...REFRESH_COOKIE_OPTIONS, value: '', maxAge: 0 })
}
