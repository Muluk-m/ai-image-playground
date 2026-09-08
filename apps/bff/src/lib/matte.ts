import { createHmac, timingSafeEqual } from 'node:crypto'
import { Agent, fetch as undiciFetch } from 'undici'
import { config } from '../config'
import { isObject } from './type-guards'

const SOURCE_TOKEN_TTL_MS = 5 * 60 * 1000
const TOKEN_SECRET_LABEL = 'matte-source-token'
const SOURCE_KEY_PATTERN = /^matte\/[^/]+\/source\.[a-z0-9]+$/

const CONNECT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000

export class MatteUpstreamError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`Foreground segmentation failed: ${detail}`, options)
    this.name = 'MatteUpstreamError'
  }
}

interface MatteFetchResponse {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

type MatteFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) => Promise<MatteFetchResponse>

const matteDispatcher = new Agent({
  connectTimeout: CONNECT_TIMEOUT_MS,
  headersTimeout: REQUEST_TIMEOUT_MS,
  bodyTimeout: REQUEST_TIMEOUT_MS,
})

let matteFetch: MatteFetch = undiciFetch

/** 测试注入点；undefined 恢复真实 Undici transport。 */
export function setMatteFetchForTesting(fetchImpl?: MatteFetch): void {
  matteFetch = fetchImpl ?? undiciFetch
}

function signaturePayload(payload: string): Buffer {
  const secret = createHmac('sha256', config.auth.internalApiToken)
    .update(TOKEN_SECRET_LABEL)
    .digest()
  return createHmac('sha256', secret).update(payload).digest()
}

/** 取图路由没有 cookie 鉴权，token 是它的全部授权：绑一个对象、5 分钟过期。 */
export function mintSourceToken(key: string, now = Date.now()): string {
  const payload = JSON.stringify({ key, exp: now + SOURCE_TOKEN_TTL_MS })
  const encodedPayload = Buffer.from(payload, 'utf8').toString('base64url')
  return `${encodedPayload}.${signaturePayload(payload).toString('base64url')}`
}

export function verifySourceToken(token: string, now = Date.now()): string | null {
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null

  const payload = Buffer.from(parts[0], 'base64url').toString('utf8')
  const signature = Buffer.from(parts[1], 'base64url')
  const expected = signaturePayload(payload)
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const { key, exp } = parsed
  if (typeof key !== 'string' || typeof exp !== 'number' || exp < now) return null
  return SOURCE_KEY_PATTERN.test(key) ? key : null
}

export function foregroundTransformUrl(token: string): string {
  const origin = config.matte.transformOrigin
  return `${origin}/cdn-cgi/image/segment=foreground,format=png/${origin}/api/matte/source/${token}`
}

/** 只确认这是 Cloudflare 成功产出的 PNG；alpha 通道由前端读，BFF 不解码。 */
export async function fetchForegroundPng(token: string): Promise<Uint8Array> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await matteFetch(foregroundTransformUrl(token), {
      signal: abort.signal,
      dispatcher: matteDispatcher,
    })
    if (response.status !== 200) throw new MatteUpstreamError(`HTTP ${response.status}`)
    const resized = response.headers.get('cf-resized') ?? ''
    if (resized.includes('err=')) throw new MatteUpstreamError(`cf-resized ${resized}`)
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!contentType.startsWith('image/png')) {
      throw new MatteUpstreamError(`content-type ${contentType || 'missing'}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    if (error instanceof MatteUpstreamError) throw error
    throw new MatteUpstreamError('request failed', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}
