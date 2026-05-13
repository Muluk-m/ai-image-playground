import type { ChannelConfig, ProxyError } from './types'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const HEARTBEAT_INTERVAL_MS = 20_000

function jsonError(status: number, body: ProxyError): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

export interface HandleOptions {
  request: Request
  channel: ChannelConfig | undefined
  path: string
  env: Record<string, string | undefined>
  /** 注入 fetch（默认 globalThis.fetch）便于测试 */
  fetchFn?: typeof fetch
  /** 注入心跳间隔（毫秒），测试用 */
  heartbeatIntervalMs?: number
}

export async function handleProxyRequest(opts: HandleOptions): Promise<Response> {
  const { request, channel, path, env, fetchFn = fetch, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = opts
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (method !== 'POST' && method !== 'GET') {
    return jsonError(405, { error: 'method_not_allowed', method })
  }

  if (!channel) {
    return jsonError(404, { error: 'channel_not_found' })
  }

  if (channel.disabled === true) {
    return jsonError(503, { error: 'channel_disabled', channelId: channel.id })
  }

  if (channel.kind === 'http-template') {
    return jsonError(501, { error: 'kind_not_implemented', kind: channel.kind })
  }

  // path 严格白名单（完全匹配，无 prefix、无正则、无 traversal）
  if (!channel.allowedPaths.includes(path) || path.includes('..')) {
    return jsonError(403, { error: 'path_not_allowed', channelId: channel.id, path })
  }

  const secret = env[channel.auth.secretRef]
  if (!secret || !secret.trim()) {
    return jsonError(500, { error: 'secret_missing', secretRef: channel.auth.secretRef })
  }

  // 构造转发 URL（baseUrl 末尾 / 与 path 起始 / 都不强加）
  const baseUrl = channel.baseUrl.replace(/\/+$/, '')
  const upstreamUrl = new URL(`${baseUrl}/${path}`)
  // 客户端 query string 透传
  const incoming = new URL(request.url)
  for (const [k, v] of incoming.searchParams) upstreamUrl.searchParams.set(k, v)

  // 构造转发 header：剥除客户端 Authorization 与 cookie；保留 Content-Type、Accept
  const upstreamHeaders = new Headers()
  const ct = request.headers.get('content-type')
  if (ct) upstreamHeaders.set('content-type', ct)
  const accept = request.headers.get('accept')
  if (accept) upstreamHeaders.set('accept', accept)

  // 注入凭据
  if (channel.auth.type === 'bearer') {
    upstreamHeaders.set('authorization', `Bearer ${secret}`)
  } else {
    if (channel.auth.headerName) {
      upstreamHeaders.set(channel.auth.headerName.toLowerCase(), secret)
    } else {
      upstreamUrl.searchParams.set(channel.auth.queryParam || 'key', secret)
    }
  }

  const timeoutMs = Math.max(1, channel.defaults.timeout || 600) * 1000
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)

  // 关键：不再 await fetchFn 后再 build response，而是把 fetch promise 喂给 ReadableStream，
  // 让 stream 一开始就持续推 keep-alive whitespace，CF Edge 100s idle timer 永远不触发。
  // 副作用：proxy 响应 HTTP status 永远 200；上游错误用 body 中的 envelope `_proxyError: true` 通知前端。
  const upstreamPromise = fetchFn(upstreamUrl.toString(), {
    method,
    headers: upstreamHeaders,
    body: method === 'POST' ? request.body : undefined,
    signal: abort.signal,
    // @ts-expect-error Cloudflare Workers fetch 支持 duplex:'half'，TS lib 未声明
    duplex: 'half',
  }).finally(() => clearTimeout(timer))

  const stream = makeKeepaliveStream(upstreamPromise, channel.id, heartbeatIntervalMs, abort.signal)

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // 显式开启 chunked transfer encoding（不设 content-length）
      ...CORS_HEADERS,
    },
  })
}

/**
 * 包装上游 fetch 为 keep-alive streaming 响应：
 *
 * - 每隔 `heartbeatIntervalMs` 毫秒向客户端推一个空格字节（JSON 规范允许 token 间任意 whitespace，
 *   客户端 `await response.json()` 解析时会自动忽略 leading whitespace）
 * - 上游 ok 时 pipe 原始 body；上游 non-2xx 时输出 envelope `{error, _proxyError: true}`，
 *   前端通过 `_proxyError` flag 识别并抛错
 * - 上游 fetch reject 时输出网络错误 envelope
 */
function makeKeepaliveStream(
  upstreamPromise: Promise<Response>,
  channelId: string,
  heartbeatIntervalMs: number,
  upstreamSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream({
    async start(controller) {
      let upstreamDone = false
      const heartbeat = setInterval(() => {
        if (upstreamDone) return
        try {
          controller.enqueue(encoder.encode(' '))
        } catch {
          /* controller 可能已 close（客户端 abort），忽略 */
        }
      }, heartbeatIntervalMs)

      const cleanup = () => {
        upstreamDone = true
        clearInterval(heartbeat)
      }

      try {
        const upstream = await upstreamPromise

        if (upstream.ok) {
          if (upstream.body) {
            const reader = upstream.body.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                if (value && value.byteLength > 0) controller.enqueue(value)
              }
            } finally {
              reader.releaseLock()
            }
          }
        } else {
          const rawBody = await upstream.text().catch(() => '')
          const envelope = {
            error: {
              message: extractUpstreamMessage(rawBody, upstream.status),
              type: 'upstream_error',
              upstream_status: upstream.status,
            },
            _proxyError: true,
            channelId,
          }
          controller.enqueue(encoder.encode(JSON.stringify(envelope)))
        }
      } catch (err) {
        const aborted = upstreamSignal.aborted || (err instanceof Error && err.name === 'AbortError')
        const envelope = {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: aborted ? 'upstream_timeout' : 'upstream_fetch_failed',
          },
          _proxyError: true,
          channelId,
        }
        controller.enqueue(encoder.encode(JSON.stringify(envelope)))
      } finally {
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // 客户端断开时也清理
    },
  })
}

function extractUpstreamMessage(rawBody: string, status: number): string {
  if (!rawBody) return `Upstream HTTP ${status}`
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown> | null
    if (parsed && typeof parsed === 'object') {
      const errObj = (parsed as { error?: { message?: string } }).error
      if (errObj && typeof errObj.message === 'string') return errObj.message
      if (typeof (parsed as { detail?: string }).detail === 'string') {
        return (parsed as { detail: string }).detail
      }
      if (typeof (parsed as { message?: string }).message === 'string') {
        return (parsed as { message: string }).message
      }
    }
  } catch {
    /* not JSON */
  }
  return rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
}
