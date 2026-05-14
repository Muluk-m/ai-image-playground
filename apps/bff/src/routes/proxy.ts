import { Elysia } from 'elysia'
import type { ChannelConfig, ChannelsConfig } from '../../../web/functions/_lib/types'
import { config } from '../config'
import { resolveApiKey } from '../lib/resolveApiKey'

/**
 * /api-proxy/:channelId/* — 替代 CF Pages Function 的本地反代。
 *
 * BFF 走 localhost，没有 CF Edge 100s 限制，无需心跳保活。
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const channelsConfig: ChannelsConfig = require('../../../web/config/channels.json')

const channels = channelsConfig.channels
const channelMap = new Map(channels.map((c) => [c.id, c]))

// Precompute rewritten base URLs (channel remote → local sub2api)
// e.g. https://sub2api.qiliangjia.one/antigravity/v1beta → http://localhost:8080/antigravity/v1beta
const rewrittenBaseUrls = new Map(
  channels.map((c) => {
    try {
      const pathname = new URL(c.baseUrl).pathname.replace(/\/+$/, '')
      return [c.id, `${config.sub2api.baseUrl}${pathname}`]
    } catch {
      return [c.id, config.sub2api.baseUrl]
    }
  }),
)

export const proxyRoutes = new Elysia().all(
  '/api-proxy/:channelId/*',
  async ({ request, params }) => {
    const method = request.method.toUpperCase()

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204 })
    }

    const channel = channelMap.get(params.channelId)
    if (!channel) {
      return Response.json({ error: 'channel_not_found' }, { status: 404 })
    }
    if (channel.disabled) {
      return Response.json({ error: 'channel_disabled', channelId: channel.id }, { status: 503 })
    }

    const path = (params as Record<string, string>)['*'] ?? ''
    if (!channel.allowedPaths.includes(path) || path.includes('..')) {
      return Response.json(
        { error: 'path_not_allowed', channelId: channel.id, path },
        { status: 403 },
      )
    }

    const secret = resolveApiKey(channel.kind)
    if (!secret) {
      return Response.json({ error: 'secret_missing', kind: channel.kind }, { status: 500 })
    }

    const localBase = rewrittenBaseUrls.get(channel.id) ?? config.sub2api.baseUrl
    const upstreamUrl = new URL(`${localBase}/${path}`)
    const incoming = new URL(request.url)
    for (const [k, v] of incoming.searchParams) upstreamUrl.searchParams.set(k, v)

    const upstreamHeaders = new Headers()
    const ct = request.headers.get('content-type')
    if (ct) upstreamHeaders.set('content-type', ct)
    const accept = request.headers.get('accept')
    if (accept) upstreamHeaders.set('accept', accept)

    if (channel.auth.type === 'bearer') {
      upstreamHeaders.set('authorization', `Bearer ${secret}`)
    } else if (channel.auth.type === 'query-key' && channel.auth.headerName) {
      upstreamHeaders.set(channel.auth.headerName.toLowerCase(), secret)
    } else {
      upstreamUrl.searchParams.set(
        channel.auth.type === 'query-key' ? (channel.auth.queryParam ?? 'key') : 'key',
        secret,
      )
    }

    const timeoutMs = Math.max(1, channel.defaults.timeout ?? 600) * 1000
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)

    try {
      const upstream = await fetch(upstreamUrl.toString(), {
        method,
        headers: upstreamHeaders,
        body: method === 'POST' ? request.body : undefined,
        signal: abort.signal,
        // @ts-expect-error Bun supports duplex
        duplex: 'half',
      })

      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/json',
        },
      })
    } catch (err) {
      const isTimeout = abort.signal.aborted
      return Response.json(
        {
          error: {
            message: err instanceof Error ? err.message : String(err),
            type: isTimeout ? 'upstream_timeout' : 'upstream_fetch_failed',
          },
          _proxyError: true,
          channelId: channel.id,
        },
        { status: isTimeout ? 504 : 502 },
      )
    } finally {
      clearTimeout(timer)
    }
  },
)
