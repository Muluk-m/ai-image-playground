import { Agent, fetch as undiciFetch } from 'undici'

/** 抓竞品页是用户等待中的同步请求，用自己的短超时 dispatcher，不碰生图那套分钟级预算。 */
export const LISTING_TIMEOUT_MS = 15_000
export const MAX_LISTING_HTML_BYTES = 5 * 1024 * 1024
export const MAX_LISTING_IMAGE_BYTES = 20 * 1024 * 1024

const PROXYABLE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
])

interface ListingResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

type ListingFetch = (
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) => Promise<ListingResponse>

export class ListingFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ListingFetchError'
  }
}

const listingDispatcher = new Agent({
  connectTimeout: LISTING_TIMEOUT_MS,
  headersTimeout: LISTING_TIMEOUT_MS,
  bodyTimeout: LISTING_TIMEOUT_MS,
})

/** 不带浏览器 UA 与英文 Accept-Language 时亚马逊直接回验证码页。 */
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
}

let listingFetch: ListingFetch = undiciFetch

/** 测试注入点；undefined 恢复真实 Undici transport。 */
export function setListingFetchForTesting(fetchImpl?: ListingFetch): void {
  listingFetch = fetchImpl ?? undiciFetch
}

async function request(url: string, accept?: string): Promise<ListingResponse> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), LISTING_TIMEOUT_MS)
  try {
    const response = await listingFetch(url, {
      headers: accept ? { ...BROWSER_HEADERS, accept } : BROWSER_HEADERS,
      signal: abort.signal,
      dispatcher: listingDispatcher,
      redirect: 'follow',
    })
    if (!response.ok) throw new ListingFetchError(`upstream responded ${response.status}`)
    return response
  } catch (error) {
    if (error instanceof ListingFetchError) throw error
    throw new ListingFetchError(`cannot reach ${url}`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(response: ListingResponse, limit: number): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    throw new ListingFetchError('response exceeds the size limit')
  }
  const body = await response.arrayBuffer()
  if (body.byteLength > limit) throw new ListingFetchError('response exceeds the size limit')
  return body
}

export async function fetchListingHtml(url: string): Promise<string> {
  const response = await request(url)
  return new TextDecoder().decode(await readBounded(response, MAX_LISTING_HTML_BYTES))
}

export interface FetchedImage {
  readonly body: ArrayBuffer
  readonly contentType: string
}

export async function fetchListingImage(url: string): Promise<FetchedImage> {
  const response = await request(url, 'image/avif,image/webp,image/*,*/*;q=0.8')
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim()
  // 白名单而非 `image/` 前缀：BFF 与前端同源，代理回一张 image/svg+xml 就是本站的 XSS。
  if (!PROXYABLE_IMAGE_TYPES.has(contentType)) {
    throw new ListingFetchError(`upstream returned ${contentType || 'no content type'}`)
  }
  return { body: await readBounded(response, MAX_LISTING_IMAGE_BYTES), contentType }
}
