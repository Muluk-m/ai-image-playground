import { createHash, createHmac } from 'node:crypto'
import { signPayload, verifyPayload } from '@image-playground/node-kit'
import { config } from '../config'
import { objectStore } from './objectStore'
import { createDispatcher, createFetchSlot, type Dispatcher, withDeadline } from './timeoutFetch'

const SOURCE_TOKEN_TTL_MS = 5 * 60 * 1000
const TOKEN_SECRET_LABEL = 'matte-source-token'
const SOURCE_KEY_PATTERN = /^matte\/[0-9a-f]{64}\/source\.[a-z0-9]+$/

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
  url: string,
  init: { signal: AbortSignal; dispatcher?: Dispatcher },
) => Promise<MatteFetchResponse>

const matteDispatcher = createDispatcher({ connectMs: CONNECT_TIMEOUT_MS })

const matteTransport = createFetchSlot<MatteFetch>()

export function setMatteFetchForTesting(fetchImpl?: MatteFetch): void {
  matteTransport.set(fetchImpl)
}

/** 派生一把只给取图 token 用的密钥，别让它和其他 INTERNAL_API_TOKEN 用途共用签名空间。 */
function sourceTokenSecret(): Buffer {
  return createHmac('sha256', config.auth.internalApiToken).update(TOKEN_SECRET_LABEL).digest()
}

/** 取图路由没有 cookie 鉴权，token 是它的全部授权：绑一个对象、5 分钟过期。 */
export function mintSourceToken(key: string, now = Date.now()): string {
  return signPayload(sourceTokenSecret(), { key }, { ttlMs: SOURCE_TOKEN_TTL_MS, now })
}

export function verifySourceToken(token: string, now = Date.now()): string | null {
  const payload = verifyPayload(sourceTokenSecret(), token, { now })
  if (!payload || typeof payload.key !== 'string') return null
  return SOURCE_KEY_PATTERN.test(payload.key) ? payload.key : null
}

function foregroundTransformUrl(token: string): string {
  const origin = config.matte.transformOrigin
  return `${origin}/cdn-cgi/image/segment=foreground,format=png/${origin}/api/matte/source/${token}`
}

/** 只确认这是 Cloudflare 成功产出的 PNG；alpha 通道由前端读，BFF 不解码。 */
function fetchForegroundPng(token: string): Promise<Uint8Array> {
  return withDeadline(REQUEST_TIMEOUT_MS, async (signal) => {
    try {
      const response = await matteTransport.current(foregroundTransformUrl(token), {
        signal,
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
    }
  })
}

/** 对象键的扩展名就是 mime 子类型，jpeg 单独收敛成 jpg。 */
function sourceExtension(mime: string): string {
  const subtype = mime.slice(mime.indexOf('/') + 1)
  return subtype === 'jpeg' ? 'jpg' : subtype
}

export function sourceContentType(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1)
  return `image/${extension === 'jpg' ? 'jpeg' : extension}`
}

/** A hit downloads the alpha directly: no metadata/existence request before the read. */
export async function cachedForeground(hash: string): Promise<Uint8Array | null> {
  try {
    return await objectStore().read(`matte/${hash}/alpha.png`)
  } catch {
    // Keep the POST path's existing cache-miss behavior for unreadable objects.
    return null
  }
}

/** 按原图内容哈希缓存，同一张图重复进来只调一次 Cloudflare。 */
export async function segmentForeground(
  bytes: Uint8Array,
  mime: string,
): Promise<{ png: Uint8Array; cached: boolean }> {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const cached = await cachedForeground(hash)
  if (cached) return { png: cached, cached: true }
  const store = objectStore()
  const alphaKey = `matte/${hash}/alpha.png`

  const sourceKey = `matte/${hash}/source.${sourceExtension(mime)}`
  await store.write(sourceKey, bytes, mime)
  const png = await fetchForegroundPng(mintSourceToken(sourceKey))
  await store.write(alphaKey, png, 'image/png')
  return { png, cached: false }
}
