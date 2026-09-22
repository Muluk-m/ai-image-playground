import { config } from '../config'

export interface InternalBffRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  operator?: string
}

/** Forward an authenticated Admin request to the BFF's service-only operational surface. */
export async function forwardInternalBff(request: InternalBffRequest): Promise<Response> {
  const token = config.auth.internalApiToken
  if (!token) {
    return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
  }
  const response = await fetch(`${config.bffInternalUrl}${request.path}`, {
    method: request.method ?? 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(request.operator ? { 'x-admin-operator': request.operator } : {}),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: AbortSignal.timeout(15_000),
  })
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  })
}
