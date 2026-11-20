import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * OpenObserve 前面的只读代理（ADR 0033）。开源版没有只读角色，服务账号什么都能改，所以对外
 * 只放这个代理：独立的 Bearer 令牌鉴权，只放行查询类路径，OpenObserve 的账号由代理代填，
 * 调用方拿不到。`scripts/obs.ts` 经它查日志和链路。
 */

export interface ObsProxyOptions {
  /** OpenObserve 地址，例如 `http://openobserve:5080`。 */
  readonly upstream: string
  /** 只放行这一个组织。 */
  readonly org: string
  /** 调用方要带的 Bearer 令牌。 */
  readonly token: string
  readonly username: string
  readonly password: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

/** 查询语句和 trace 查询都很小；再大就是误用。 */
export const OBS_PROXY_MAX_BODY_BYTES = 64 * 1024

type Rule = { readonly method: 'GET' | 'POST'; readonly pattern: RegExp }

/** `{org}` 之后的路径。`_search` 是只读 SQL；streams 列出有哪些流；traces/latest 列最近的链路。 */
const ALLOWED: readonly Rule[] = [
  { method: 'POST', pattern: /^\/_search$/ },
  { method: 'GET', pattern: /^\/streams$/ },
  { method: 'GET', pattern: /^\/[A-Za-z0-9_-]{1,100}\/traces\/latest$/ },
]

export function createObsProxy(options: ObsProxyOptions): (request: Request) => Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const upstream = options.upstream.replace(/\/+$/, '')
  const expected = digest(`Bearer ${options.token}`)
  const basic = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`
  const prefix = `/api/${options.org}`
  const timeoutMs = options.timeoutMs ?? 60_000

  return async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/healthz') return new Response('ok')
    if (!digestEquals(digest(request.headers.get('authorization') ?? ''), expected))
      return json(401, { error: 'unauthorized' })
    if (!url.pathname.startsWith(`${prefix}/`)) return json(403, { error: 'forbidden' })
    const rest = url.pathname.slice(prefix.length)
    if (!ALLOWED.some((rule) => rule.method === request.method && rule.pattern.test(rest)))
      return json(403, { error: 'forbidden' })

    let body: Uint8Array<ArrayBuffer> | undefined
    if (request.method === 'POST') {
      const declared = Number(request.headers.get('content-length') ?? 0)
      if (declared > OBS_PROXY_MAX_BODY_BYTES) return json(413, { error: 'body too large' })
      const read = await readCapped(request, OBS_PROXY_MAX_BODY_BYTES).catch(
        () => 'failed' as const,
      )
      // 上传中途断开或流出错：受控地回 400，而不是让异常冒出处理器。
      if (read === 'failed') return json(400, { error: 'request body could not be read' })
      if (!read) return json(413, { error: 'body too large' })
      body = read
    }

    const response = await fetchImpl(`${upstream}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        authorization: basic,
        ...(body
          ? { 'content-type': request.headers.get('content-type') ?? 'application/json' }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(() => undefined)
    if (!response) return json(502, { error: 'openobserve unavailable' })
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  }
}

/** 边读边数：分块上传没有 Content-Length，超过上限就取消读取，不把整个请求体攒进内存。 */
async function readCapped(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return undefined
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function digestEquals(a: Buffer, b: Buffer): boolean {
  return timingSafeEqual(a, b)
}

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status })
}
