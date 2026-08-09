import { Elysia } from 'elysia'
import { config } from '../config'
import { requireAuth } from '../lib/middleware'

const PRIVATE_API_PREFIX = '/api/private'
const SAFE_PRIVATE_PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/

async function forwardPrivateOperation(request: Request): Promise<Response> {
  const token = config.auth.internalApiToken
  if (!token) {
    return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
  }

  const url = new URL(request.url)
  const path = url.pathname.slice(PRIVATE_API_PREFIX.length)
  if (!SAFE_PRIVATE_PATH.test(path) || path.includes('..')) {
    return Response.json({ error: 'invalid_private_path' }, { status: 400 })
  }

  const method = request.method.toUpperCase()
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(method)) {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 })
  }

  const headers = new Headers({
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  })
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  const response = await fetch(
    `${config.bffInternalUrl}/internal/admin/private${path}${url.search}`,
    {
      method,
      headers,
      body: method === 'GET' ? undefined : await request.arrayBuffer(),
    },
  )
  return new Response(response.body, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
  })
}

export const privateRoutes = new Elysia({ prefix: PRIVATE_API_PREFIX })
  .use(requireAuth)
  .all('/*', ({ request }) => forwardPrivateOperation(request))

export const extensionRoutes = new Elysia({ prefix: '/api' })
  .use(requireAuth)
  .get('/extensions', async () => {
    const token = config.auth.internalApiToken
    if (!token) {
      return Response.json({ error: 'internal_service_unconfigured' }, { status: 503 })
    }
    const response = await fetch(`${config.bffInternalUrl}/internal/admin/extensions`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    })
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
    })
  })
