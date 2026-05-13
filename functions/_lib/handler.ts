import type { ChannelConfig, ProxyError } from './types'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const HEARTBEAT_INTERVAL_MS = 20_000
const ENCODER = new TextEncoder()
const HEARTBEAT_BYTE = ENCODER.encode(' ')

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

  if (!channel.allowedPaths.includes(path) || path.includes('..')) {
    return jsonError(403, { error: 'path_not_allowed', channelId: channel.id, path })
  }

  const secret = env[channel.auth.secretRef]
  if (!secret || !secret.trim()) {
    return jsonError(500, { error: 'secret_missing', secretRef: channel.auth.secretRef })
  }

  const baseUrl = channel.baseUrl.replace(/\/+$/, '')
  const upstreamUrl = new URL(`${baseUrl}/${path}`)
  const incoming = new URL(request.url)
  for (const [k, v] of incoming.searchParams) upstreamUrl.searchParams.set(k, v)

  const upstreamHeaders = new Headers()
  const ct = request.headers.get('content-type')
  if (ct) upstreamHeaders.set('content-type', ct)
  const accept = request.headers.get('accept')
  if (accept) upstreamHeaders.set('accept', accept)

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

  // 不 await fetchFn——把 promise 喂给 ReadableStream，stream 从第一刻起就持续推
  // keep-alive whitespace。否则上游 30-90s buffer 期间 0 字节流出，CF Edge 100s
  // idle 计时器必触发 524。代价：HTTP status 永远 200，上游错误经 body envelope
  // 通知前端（`_proxyError: true`）。
  const upstreamPromise = fetchFn(upstreamUrl.toString(), {
    method,
    headers: upstreamHeaders,
    body: method === 'POST' ? request.body : undefined,
    signal: abort.signal,
    // @ts-expect-error Cloudflare Workers fetch 支持 duplex:'half'，TS lib 未声明
    duplex: 'half',
  }).finally(() => clearTimeout(timer))

  const stream = makeKeepaliveStream(upstreamPromise, channel.id, heartbeatIntervalMs, abort)

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...CORS_HEADERS,
    },
  })
}

function errorEnvelope(channelId: string, message: string, type: string, upstreamStatus?: number): Uint8Array {
  const errorPart: Record<string, unknown> = { message, type }
  if (upstreamStatus !== undefined) errorPart.upstream_status = upstreamStatus
  return ENCODER.encode(JSON.stringify({ error: errorPart, _proxyError: true, channelId }))
}

function makeKeepaliveStream(
  upstreamPromise: Promise<Response>,
  channelId: string,
  heartbeatIntervalMs: number,
  upstreamAbort: AbortController,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      let upstreamDone = false
      const heartbeat = setInterval(() => {
        if (upstreamDone) return
        try {
          controller.enqueue(HEARTBEAT_BYTE)
        } catch {
          /* controller 可能已 close（客户端 abort），忽略 */
        }
      }, heartbeatIntervalMs)

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
          controller.enqueue(errorEnvelope(
            channelId,
            extractUpstreamMessage(rawBody, upstream.status),
            'upstream_error',
            upstream.status,
          ))
        }
      } catch (err) {
        const aborted = upstreamAbort.signal.aborted || (err instanceof Error && err.name === 'AbortError')
        controller.enqueue(errorEnvelope(
          channelId,
          err instanceof Error ? err.message : String(err),
          aborted ? 'upstream_timeout' : 'upstream_fetch_failed',
        ))
      } finally {
        upstreamDone = true
        clearInterval(heartbeat)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // 客户端断开时同步中断上游 fetch，避免 CF Worker / 上游 API quota 继续消耗
      upstreamAbort.abort()
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
