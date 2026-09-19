export interface WorkerHealthOptions {
  staleAfterMs: number
  lastSuccessfulPollAt: () => number | null
  now?: () => number
  drain?: () => void
  resume?: () => void
  drainStatus?: () => { draining: boolean; active: number; safeToStop: boolean }
}

export interface WorkerHealthServerOptions extends WorkerHealthOptions {
  port: number
}

function json(payload: Record<string, unknown>, status: number): Response {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export function createWorkerHealthHandler(options: WorkerHealthOptions) {
  const now = options.now ?? Date.now

  return (request: Request): Response => {
    const url = new URL(request.url)
    if (
      url.pathname === '/internal/deployment/resume' &&
      request.method === 'POST' &&
      options.resume
    ) {
      options.resume()
      return json({ ok: true }, 200)
    }
    if (url.pathname === '/internal/deployment/drain' && options.drainStatus) {
      if (request.method === 'POST') options.drain?.()
      else if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405)
      return json(options.drainStatus(), 200)
    }
    if (request.method !== 'GET' || url.pathname !== '/health') {
      return json({ error: 'not_found' }, 404)
    }

    const lastSuccessfulPollAt = options.lastSuccessfulPollAt()
    if (lastSuccessfulPollAt === null) {
      return json(
        {
          ok: false,
          status: 'starting',
          lastSuccessfulPollAt: null,
          staleAfterMs: options.staleAfterMs,
        },
        503,
      )
    }

    const pollAgeMs = Math.max(0, now() - lastSuccessfulPollAt)
    const active = pollAgeMs <= options.staleAfterMs
    return json(
      {
        ok: active,
        status: active ? 'active' : 'stale',
        lastSuccessfulPollAt,
        pollAgeMs,
        staleAfterMs: options.staleAfterMs,
      },
      active ? 200 : 503,
    )
  }
}

export function startWorkerHealthServer(options: WorkerHealthServerOptions) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: options.port,
    fetch: createWorkerHealthHandler(options),
  })
}
