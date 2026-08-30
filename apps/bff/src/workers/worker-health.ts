export interface WorkerHealthOptions {
  staleAfterMs: number
  lastSuccessfulPollAt: () => number | null
  now?: () => number
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
