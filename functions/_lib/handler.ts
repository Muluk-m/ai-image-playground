import type { ChannelConfig, ProxyError } from './types'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

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
}

export async function handleProxyRequest(opts: HandleOptions): Promise<Response> {
  const { request, channel, path, env, fetchFn = fetch } = opts
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

  let upstreamRes: Response
  try {
    upstreamRes = await fetchFn(upstreamUrl.toString(), {
      method,
      headers: upstreamHeaders,
      body: method === 'POST' ? request.body : undefined,
      signal: abort.signal,
      // @ts-expect-error Cloudflare Workers fetch 支持 duplex:'half'，TS lib 未声明
      duplex: 'half',
    })
  } catch (err) {
    clearTimeout(timer)
    const aborted = err instanceof Error && err.name === 'AbortError'
    return jsonError(aborted ? 504 : 502, {
      error: aborted ? 'upstream_timeout' : 'upstream_fetch_failed',
      channelId: channel.id,
      message: err instanceof Error ? err.message : String(err),
    })
  }
  clearTimeout(timer)

  // 流式回传：保留 status / content-type，剥除 cookie 与可能引起跨域问题的 hop-by-hop header
  const passthroughHeaders = new Headers()
  for (const name of ['content-type', 'content-length', 'cache-control', 'etag']) {
    const v = upstreamRes.headers.get(name)
    if (v) passthroughHeaders.set(name, v)
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) passthroughHeaders.set(k, v)

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: passthroughHeaders,
  })
}
