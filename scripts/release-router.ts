// Stable ingress: swapping the small route file affects only new HTTP requests.
// In-flight responses retain their original upstream and are never replayed.
const routeFile = process.env.RELEASE_ROUTE_FILE ?? '/run/release/route.json'
Bun.serve({
  port: 37377,
  idleTimeout: 255,
  maxRequestBodySize: 600 * 1024 * 1024,
  async fetch(request) {
    try {
      const route = (await Bun.file(routeFile).json()) as { origin: string }
      if (!/^http:\/\/[a-zA-Z0-9_-]+:37377$/.test(route.origin))
        throw new Error('Invalid release origin')
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
