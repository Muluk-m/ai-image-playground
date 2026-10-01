import { config } from '../config'

export async function forwardTaskReconciliation(taskId: string, command?: Record<string, unknown>) {
  const token = config.auth.internalApiToken
  if (!token) return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
  const baseUrl = (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(
    /\/+$/,
    '',
  )
  const response = await fetch(
    `${baseUrl}/internal/admin/tasks/${encodeURIComponent(taskId)}/reconciliation`,
    {
      method: command ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(command ? { 'content-type': 'application/json' } : {}),
      },
      ...(command ? { body: JSON.stringify(command) } : {}),
    },
  )
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  })
}
