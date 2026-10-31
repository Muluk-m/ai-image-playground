import { and, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import {
  CLI_CLIENT_ID,
  CLI_CLIENT_NAME,
  CLI_DEFAULT_SCOPES,
  createDeviceAuthorization,
  exchangeDeviceCode,
  hashCliToken,
  revokeCliToken,
  rotateRefreshToken,
  setDeviceDecision,
} from '../lib/cli-auth'
import { resolveAuthUser } from '../lib/user-auth'
import { bffOrigin } from './oauth'

function formBody(request: Request): Promise<URLSearchParams> {
  return request.text().then((text) => new URLSearchParams(text))
}

/** Unauthenticated confirmation goes through website login and comes back to the same code. */
function loginRedirect(request: Request, code: string): Response {
  const returnTo = `/oauth/device?user_code=${encodeURIComponent(code)}`
  const frontend = config.auth.frontendOrigin || new URL(request.url).origin
  return new Response(null, {
    status: 302,
    headers: { location: `${frontend}/login?return_to=${encodeURIComponent(returnTo)}` },
  })
}

function oauthError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

export const cliAuthRoutes = new Elysia()
  .onBeforeHandle({ as: 'scoped' }, () => {
    if (!isCapabilityEnabled('cli:api')) return capabilityUnavailable('cli:api')
  })
  .post('/oauth/device_authorization', async ({ request }) => {
    const body = await formBody(request)
    const clientId = body.get('client_id') ?? ''
    if (clientId !== CLI_CLIENT_ID) return oauthError('invalid_client')
    const result = await createDeviceAuthorization(clientId, `${bffOrigin(request)}/oauth/device`)
    if (!result) return oauthError('invalid_client', 400)
    return Response.json(result, { headers: { 'cache-control': 'no-store' } })
  })
  .post('/oauth/token', async ({ request }) => {
    const body = await formBody(request)
    const clientId = body.get('client_id') ?? ''
    if (clientId !== CLI_CLIENT_ID) return oauthError('invalid_client')
    const grantType = body.get('grant_type')
    const result =
      grantType === 'urn:ietf:params:oauth:grant-type:device_code'
        ? await exchangeDeviceCode(body.get('device_code') ?? '', clientId)
        : grantType === 'refresh_token'
          ? await rotateRefreshToken(body.get('refresh_token') ?? '', clientId)
          : { ok: false as const, error: 'unsupported_grant_type' }
    if (!result.ok) return oauthError(result.error)
    return Response.json(result.tokens, { headers: { 'cache-control': 'no-store' } })
  })
  .post('/oauth/revoke', async ({ request }) => {
    const body = await formBody(request)
    if (body.get('client_id') !== CLI_CLIENT_ID) return oauthError('invalid_client')
    await revokeCliToken(body.get('token') ?? '', CLI_CLIENT_ID)
    return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
  })
  .use(resolveAuthUser)
  .get('/oauth/device', async ({ authUser, query, request }) => {
    const code = typeof query.user_code === 'string' ? query.user_code : ''
    const [authorization] = await db
      .select({
        clientName: schema.oauth_clients.name,
        scopes: schema.device_authorizations.scopes,
      })
      .from(schema.device_authorizations)
      .innerJoin(
        schema.oauth_clients,
        eq(schema.oauth_clients.id, schema.device_authorizations.client_id),
      )
      .where(eq(schema.device_authorizations.user_code_hash, hashCliToken(code)))
      .limit(1)
    if (!authUser) return loginRedirect(request, code)
    const escaped = code.replace(/[<>&]/g, '')
    const clientName = (authorization?.clientName ?? CLI_CLIENT_NAME).replace(/[<>&]/g, '')
    const scopes = (authorization?.scopes ?? CLI_DEFAULT_SCOPES).replace(/[<>&]/g, '')
    return new Response(
      `<html><body><h1>Authorize ${clientName}</h1><p>Code: ${escaped}</p><p>Permissions: ${scopes}</p><form method="post" action="/oauth/device"><input type="hidden" name="user_code" value="${escaped.replace(/"/g, '')}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    )
  })
  .post('/oauth/device', async ({ authUser, request }) => {
    const origin = request.headers.get('origin')
    if (origin && origin !== bffOrigin(request))
      return new Response('Invalid origin', { status: 403 })
    const body = await formBody(request)
    const code = body.get('user_code') ?? ''
    if (!authUser) return loginRedirect(request, code)
    const approved = body.get('decision') === 'approve'
    const changed = await setDeviceDecision(code, authUser.id, approved ? 'approved' : 'denied')
    if (!changed) return new Response('Invalid or expired code', { status: 400 })
    return new Response(
      approved
        ? 'CLI connection approved. You may return to your terminal.'
        : 'CLI connection denied.',
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
    )
  })
  .get('/api/me/cli-connections', async ({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    const connections = await db
      .select({
        id: schema.cli_connections.id,
        client_id: schema.cli_connections.client_id,
        created_at: schema.cli_connections.created_at,
        last_used_at: schema.cli_connections.last_used_at,
        revoked_at: schema.cli_connections.revoked_at,
      })
      .from(schema.cli_connections)
      .where(eq(schema.cli_connections.user_id, authUser.id))
    return {
      connections: connections.map(({ id, client_id, created_at, last_used_at, revoked_at }) => ({
        id,
        client_id,
        created_at,
        last_used_at,
        revoked: revoked_at !== null,
      })),
    }
  })
  .delete(
    '/api/me/cli-connections/:id',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const [connection] = await db
        .select({ family_id: schema.cli_connections.family_id })
        .from(schema.cli_connections)
        .where(
          and(
            eq(schema.cli_connections.id, params.id),
            eq(schema.cli_connections.user_id, authUser.id),
          ),
        )
        .limit(1)
      if (connection) {
        await db
          .update(schema.cli_connections)
          .set({ revoked_at: Date.now() })
          .where(
            and(
              eq(schema.cli_connections.family_id, connection.family_id),
              eq(schema.cli_connections.user_id, authUser.id),
            ),
          )
      }
      return { ok: true }
    },
    { params: t.Object({ id: t.String({ minLength: 1, maxLength: 64 }) }) },
  )

export { CLI_CLIENT_ID, hashCliToken }
