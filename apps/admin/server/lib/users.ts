import { config } from '../config'

export interface UserOperationRequest {
  method: 'POST' | 'PATCH'
  path: string
  body?: unknown
}

/**
 * Forward user mutations to the BFF, which is the sole writer for account and session state.
 * The Admin process connects to PostgreSQL with SELECT-only grants.
 */
export async function forwardUserOperation(request: UserOperationRequest): Promise<Response> {
  const token = config.auth.internalApiToken
  if (!token) {
    return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
  }

  const baseUrl = (process.env.BFF_INTERNAL_URL?.trim() || config.bffInternalUrl).replace(
    /\/+$/,
    '',
  )
  const response = await fetch(`${baseUrl}/internal/admin/users${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  })
}
