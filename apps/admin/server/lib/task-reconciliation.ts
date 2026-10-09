import { config } from '../config'

export async function forwardTaskReconciliation(taskId: string, command?: Record<string, unknown>) {
  const token = config.auth.internalApiToken
  if (!token) return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
  const baseUrl = (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(
    /\/+$/,
    '',
  )
  const signal = AbortSignal.timeout(90_000)
  try {
    const response = await fetch(
      `${baseUrl}/internal/admin/tasks/${encodeURIComponent(taskId)}/reconciliation`,
      {
        method: command ? 'POST' : 'GET',
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(command ? { 'content-type': 'application/json' } : {}),
        },
        ...(command ? { body: JSON.stringify(command) } : {}),
      },
    )
    const body = await response.arrayBuffer()
    return new Response(body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  } catch {
    const timedOut = signal.aborted
    return Response.json(
      command
        ? { error: 'reconciliation_result_uncertain', commandId: command.commandId }
        : {
            error: timedOut
              ? 'reconciliation_service_timeout'
              : 'reconciliation_service_unavailable',
          },
      { status: timedOut ? 504 : 502 },
    )
  }
}
