// Stable ingress: swapping the small route file affects only new HTTP requests.
// In-flight responses retain their original upstream and are never replayed.
//
// WebSocket upgrades are a separate bridge. Bun's fetch() accepts the handshake and then
// forwards a binary canvas frame as an illegal control frame, so the public socket dies
// (1002 here, 1006 once Cloudflare is in front). Data frames are copied across two sockets;
// ping and close stay on each hop.

const routeFile = process.env.RELEASE_ROUTE_FILE ?? '/run/release/route.json'
const port = Number(process.env.RELEASE_ROUTER_PORT ?? 37377)
const originPort = process.env.RELEASE_ORIGIN_PORT ?? '37377'
const allowedOrigin = new RegExp(`^http://[a-zA-Z0-9_-]+:${originPort}$`)
const upstreamConnectMs = 5_000
// Matches packages/shared canvas sync, plus the small frame header. This script stays free of
// workspace imports because the image runs it directly.
const maxFrameBytes = 4 * 1024 * 1024 + 64

const droppedHeaders = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-key',
  'sec-websocket-protocol',
  'sec-websocket-version',
])

type Relay = {
  upstream: WebSocket
  pending: Array<string | ArrayBuffer>
  socket: {
    readyState: number
    send(data: string | ArrayBuffer): void
    close(code?: number, reason?: string): void
  } | null
  closed: boolean
  closeCode: number
  closeReason: string
}

function safeCode(code: number): number {
  const reserved = code === 1004 || code === 1005 || code === 1006 || code === 1015
  if (!Number.isInteger(code) || reserved || code < 1000 || code > 4999) return 1011
  return code
}

function safeReason(reason: string): string {
  return reason.length <= 123 ? reason : reason.slice(0, 123)
}

function closeQuietly(socket: { close(code?: number, reason?: string): void }): void {
  try {
    socket.close()
  } catch {
    // Already closing or already closed.
  }
}

async function readOrigin(): Promise<string> {
  const route = (await Bun.file(routeFile).json()) as { origin: string }
  if (!allowedOrigin.test(route.origin)) throw new Error('Invalid release origin')
  return route.origin
}

function forwardedHeaders(request: Request, host: string): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, name) => {
    if (!droppedHeaders.has(name)) headers[name] = value
  })
  headers.host = host
  return headers
}

function rememberClose(relay: Relay, code: number, reason: string): void {
  if (relay.closed) return
  relay.closed = true
  relay.closeCode = safeCode(code)
  relay.closeReason = safeReason(reason)
  const socket = relay.socket
  if (!socket || socket.readyState !== 1) return
  try {
    socket.close(relay.closeCode, relay.closeReason)
  } catch {
    closeQuietly(socket)
  }
}

function bridgeUpstream(upstream: WebSocket): Relay {
  const relay: Relay = {
    upstream,
    pending: [],
    socket: null,
    closed: false,
    closeCode: 1000,
    closeReason: '',
  }
  upstream.binaryType = 'arraybuffer'
  upstream.addEventListener('message', (event) => {
    const frame = event.data
    if (typeof frame !== 'string' && !(frame instanceof ArrayBuffer)) return
    const socket = relay.socket
    if (socket && socket.readyState === 1) socket.send(frame)
    else relay.pending.push(frame)
  })
  upstream.addEventListener('close', (event) => {
    rememberClose(relay, event.code, event.reason)
  })
  upstream.addEventListener('error', () => {
    rememberClose(relay, 1011, 'upstream_unavailable')
  })
  return relay
}

function connectUpstream(url: string, headers: Record<string, string>): Promise<Relay> {
  const upstream = new WebSocket(url, { headers })
  const relay = bridgeUpstream(upstream)
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const fail = (error: Error) => {
      clearTimeout(timer)
      rememberClose(relay, 1011, 'upstream_unavailable')
      closeQuietly(upstream)
      reject(error)
    }
    timer = setTimeout(() => fail(new Error('upstream websocket timed out')), upstreamConnectMs)
    upstream.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve(relay)
      },
      { once: true },
    )
    upstream.addEventListener('error', () => fail(new Error('upstream websocket failed')), {
      once: true,
    })
  })
}

const server = Bun.serve<Relay>({
  port,
  idleTimeout: 255,
  // Same limit as the BFF behind it; Cloudflare caps public requests at 100 MB anyway.
  maxRequestBodySize: 100 * 1024 * 1024,
  async fetch(request, bunServer) {
    try {
      const origin = await readOrigin()
      const incoming = new URL(request.url)
      if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const target = `ws://${new URL(origin).host}${incoming.pathname}${incoming.search}`
        let relay: Relay
        try {
          relay = await connectUpstream(target, forwardedHeaders(request, incoming.host))
        } catch {
          return Response.json({ error: 'service_temporarily_unavailable' }, { status: 503 })
        }
        if (relay.closed || !bunServer.upgrade(request, { data: relay })) {
          rememberClose(relay, 1011, 'upgrade_failed')
          closeQuietly(relay.upstream)
          return Response.json({ error: 'service_temporarily_unavailable' }, { status: 503 })
        }
        return undefined
      }
      const headers = new Headers(request.headers)
      // Route by the fixed upstream URL, but keep the public authority for domain-bound auth.
      headers.set('host', incoming.host)
      return await fetch(`${origin}${incoming.pathname}${incoming.search}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        signal: request.signal,
        redirect: 'manual',
      })
    } catch {
      return Response.json({ error: 'service_temporarily_unavailable' }, { status: 503 })
    }
  },
  websocket: {
    idleTimeout: 255,
    maxPayloadLength: maxFrameBytes,
    open(ws) {
      const relay = ws.data
      relay.socket = ws
      for (const frame of relay.pending.splice(0)) ws.send(frame)
      if (relay.closed) {
        try {
          ws.close(relay.closeCode, relay.closeReason)
        } catch {
          closeQuietly(ws)
        }
      }
    },
    message(ws, message) {
      const relay = ws.data
      if (relay.closed || relay.upstream.readyState !== WebSocket.OPEN) return
      if (typeof message !== 'string' && !(message instanceof Uint8Array)) return
      relay.upstream.send(message)
    },
    close(ws, code, reason) {
      const relay = ws.data
      if (relay.closed) return
      relay.closed = true
      try {
        relay.upstream.close(safeCode(code), safeReason(reason))
      } catch {
        closeQuietly(relay.upstream)
      }
    },
  },
})

// A rollout replaces the router with one on the release image. Its replacement already shares the
// network alias, so stop accepting and let requests in flight finish before exiting.
process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0))
})
