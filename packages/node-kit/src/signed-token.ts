import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * 无状态签名 token：`<payload>.<base64url hmac-sha256>`，HMAC 覆盖解码后的 payload 文本。
 * 分隔符取最后一个 `.`，因为 `text` 编码的 payload 自己可能带点（ISO 时间戳的毫秒）。
 */

export type TokenSecret = string | Buffer

/** payload 段的编码；`text` 让 payload 明文入 token，用于已在外流通的历史格式。 */
export type PayloadEncoding = 'base64url' | 'text'

const BASE64URL = /^[A-Za-z0-9_-]+$/

function sign(secret: TokenSecret, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest()
}

function decodePayload(segment: string, encoding: PayloadEncoding): string | null {
  if (encoding === 'text') return segment
  // Buffer 的 base64url 解码不报错，非法字符会被静默丢掉，先自己把关。
  if (!BASE64URL.test(segment)) return null
  return Buffer.from(segment, 'base64url').toString('utf8')
}

export function signToken(
  secret: TokenSecret,
  payload: string,
  encoding: PayloadEncoding = 'base64url',
): string {
  const encoded = encoding === 'text' ? payload : Buffer.from(payload, 'utf8').toString('base64url')
  return `${encoded}.${sign(secret, payload).toString('base64url')}`
}

/** 只验签，返回原 payload 文本；过期与内容校验归调用方。 */
export function verifyToken(
  secret: TokenSecret,
  token: string,
  encoding: PayloadEncoding = 'base64url',
): string | null {
  const separator = token.lastIndexOf('.')
  if (separator <= 0) return null

  const payload = decodePayload(token.slice(0, separator), encoding)
  if (payload === null) return null

  const provided = token.slice(separator + 1)
  if (!BASE64URL.test(provided)) return null

  const signature = Buffer.from(provided, 'base64url')
  const expected = sign(secret, payload)
  // timingSafeEqual 要求两 buffer 等长，否则直接抛。
  if (signature.length !== expected.length) return null
  return timingSafeEqual(signature, expected) ? payload : null
}

export interface SignPayloadOptions {
  readonly ttlMs: number
  readonly now?: number
}

/** 给 payload 盖上 `exp` 再签名。 */
export function signPayload(
  secret: TokenSecret,
  payload: Record<string, unknown>,
  { ttlMs, now = Date.now() }: SignPayloadOptions,
): string {
  return signToken(secret, JSON.stringify({ ...payload, exp: now + ttlMs }))
}

/** 验签并检查 `exp`；字段类型由调用方收窄。 */
export function verifyPayload(
  secret: TokenSecret,
  token: string,
  { now = Date.now() }: { readonly now?: number } = {},
): Record<string, unknown> | null {
  const text = verifyToken(secret, token)
  if (text === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const payload = parsed as Record<string, unknown>
  if (typeof payload.exp !== 'number' || payload.exp < now) return null
  return payload
}
