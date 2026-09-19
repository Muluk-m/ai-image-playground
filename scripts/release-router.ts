// Stable ingress: swapping the small route file affects only new HTTP requests.
// In-flight responses retain their original upstream and are never replayed.
const routeFile = process.env.RELEASE_ROUTE_FILE ?? '/run/release/route.json'
const port = Number(process.env.RELEASE_ROUTER_PORT ?? 37377)
const originPort = process.env.RELEASE_ORIGIN_PORT ?? '37377'
const allowedOrigin = new RegExp(`^http://[a-zA-Z0-9_-]+:${originPort}$`)
const server = Bun.serve({
  port,
  idleTimeout: 255,
  maxRequestBodySize: 600 * 1024 * 1024,
  async fetch(request) {
    try {
      const route = (await Bun.file(routeFile).json()) as { origin: string }
      if (!allowedOrigin.test(route.origin)) throw new Error('Invalid release origin')
      const incoming = new URL(request.url)
      const headers = new Headers(request.headers)
      headers.delete('host')
      return await fetch(`${route.origin}${incoming.pathname}${incoming.search}`, {
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
})

// A rollout replaces the router with one on the release image. Its replacement already shares the
// network alias, so stop accepting and let requests in flight finish before exiting.
process.on('SIGTERM', () => {
  void server.stop().then(() => process.exit(0))
})
