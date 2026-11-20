/**
 * 浏览器这一端的 W3C trace context（ADR 0033 T4）。
 *
 * BFF 收到 `traceparent` 会接着这条链路建服务端 span，所以前端生成的 trace id 就是服务端日志里的
 * `trace_id`。没带的请求由服务端自己开链路，并在 `x-trace-id` 响应头里告诉我们。
 *
 * 跨域 API 上，自定义请求头会让原本的「简单请求」多一次 CORS 预检；预检缓存按 URL 计，带 id 的
 * 路径几乎每次都要重新预检。所以只给本来就要预检的请求（JSON 正文、非 GET/POST 方法等）和同源请求
 * 加 `traceparent`，不为链路多付一次往返。
 */

export const TRACEPARENT_HEADER = 'traceparent'
/** BFF 在响应头里回传本次请求所在的 trace id，见 apps/bff 的 request-context。 */
export const TRACE_ID_RESPONSE_HEADER = 'x-trace-id'

const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/
/** 失败请求的 trace id 只在这段时间内跟随错误上报，再晚的错误多半和它无关。 */
const RECENT_FAILURE_MS = 15_000

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  let hex = ''
  for (const byte of buffer) hex += byte.toString(16).padStart(2, '0')
  // 全零的 id 在 W3C 里无效；概率可以忽略，但碰上了服务端会整个丢掉这个头。
  return /^0+$/.test(hex) ? randomHex(bytes) : hex
}

export function isTraceId(value: unknown): value is string {
  return typeof value === 'string' && TRACE_ID.test(value)
}

export function newTraceId(): string {
  return randomHex(16)
}

/** 每次发送用新的 span id；sampled 标志只是建议，是否采样由服务端的采样器决定。 */
export function traceparentFor(traceId: string): string {
  return `00-${traceId}-${randomHex(8)}-01`
}

const SAFELISTED_METHODS = new Set(['GET', 'HEAD', 'POST'])
const SAFELISTED_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-language',
  'content-type',
])
const SAFELISTED_CONTENT_TYPES = new Set([
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
])

function safelistedContentType(value: string): boolean {
  const essence = value.split(';')[0]?.trim().toLowerCase() ?? ''
  return SAFELISTED_CONTENT_TYPES.has(essence)
}

/**
 * 这个请求在跨域时是否本来就会预检（Fetch 规范的 CORS-safelisted 判定，按会触发预检的一侧取舍）。
 * 判断不了的情况一律当作不预检：宁可这次不带链路，也不额外多一次往返。
 */
export function requiresPreflight(init: RequestInit): boolean {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!SAFELISTED_METHODS.has(method)) return true
  const headers = new Headers(init.headers)
  let explicitType = false
  for (const [name, value] of headers) {
    // 单段 `bytes=N-` / `bytes=N-M` 的 Range 也免预检（视频分段之类）。
    if (name === 'range') {
      if (!/^bytes=\d+-\d*$/.test(value)) return true
      continue
    }
    if (!SAFELISTED_HEADERS.has(name)) return true
    if (name === 'content-type') {
      explicitType = true
      if (!safelistedContentType(value)) return true
    }
  }
  // 没写 content-type 时浏览器按正文补：带类型的 Blob 会补成它自己的类型（image/png 之类）。
  const body = init.body
  if (!explicitType && typeof Blob !== 'undefined' && body instanceof Blob && body.type)
    return !safelistedContentType(body.type)
  return false
}

function sameOrigin(input: string): boolean {
  if (typeof location === 'undefined') return false
  try {
    return new URL(input, location.href).origin === location.origin
  } catch {
    return false
  }
}

/** 能带链路就带上：返回本次请求所属的 trace id，没带时为 null。 */
export function attachTraceparent(
  input: string,
  init: RequestInit,
  traceId: string,
): { init: RequestInit; traceId: string | null } {
  if (!sameOrigin(input) && !requiresPreflight(init)) return { init, traceId: null }
  const headers = new Headers(init.headers)
  headers.set(TRACEPARENT_HEADER, traceparentFor(traceId))
  return { init: { ...init, headers }, traceId }
}

const responseTraces = new WeakMap<Response, string>()

/** 记下这个响应属于哪条链路，之后据它构造的错误用 `traceIdOf` 取回，不依赖全局「最近失败」。 */
export function rememberResponseTrace(response: Response, traceId: string | null): void {
  if (isTraceId(traceId)) responseTraces.set(response, traceId)
}

export function traceIdOf(response: Response): string | undefined {
  const remembered = responseTraces.get(response)
  if (remembered) return remembered
  const header = response.headers.get(TRACE_ID_RESPONSE_HEADER)
  return isTraceId(header) ? header : undefined
}

/**
 * 把链路挂到错误上（不可枚举，不影响序列化与相等比较）。错误已经带了就不覆盖：
 * 最早挂上的那条才是出错的请求。
 */
export function tagTraceId<T>(error: T, traceId: string | null | undefined): T {
  if (!isTraceId(traceId) || !error || typeof error !== 'object') return error
  try {
    if (isTraceId(Reflect.get(error, 'traceId'))) return error
    Object.defineProperty(error, 'traceId', { value: traceId, configurable: true })
  } catch {
    // 冻结或带访问器的对象挂不上，退回全局兜底。
  }
  return error
}

let recentFailure: { traceId: string; at: number } | null = null

/**
 * BFF 请求失败（非 2xx 或网络错误）时记下所在链路。只是兜底：错误自己带了 `traceId` 时以它为准；
 * 多个请求交错失败时这里只剩最后一条，可能对不上。
 */
export function noteFailedTrace(traceId: string | null, now = Date.now()): void {
  if (isTraceId(traceId)) recentFailure = { traceId, at: now }
}

/** 响应头里的 trace id 优先：它一定是服务端真实记录的那条链路。 */
export function responseTraceId(response: Response, sent: string | null): string | null {
  const header = response.headers.get(TRACE_ID_RESPONSE_HEADER)
  return isTraceId(header) ? header : sent
}

export function recentFailedTraceId(now = Date.now()): string | undefined {
  if (!recentFailure || now - recentFailure.at > RECENT_FAILURE_MS) return undefined
  return recentFailure.traceId
}

/** 仅供测试。 */
export function _resetTraceContextForTesting(): void {
  recentFailure = null
}
