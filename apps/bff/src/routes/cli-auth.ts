import { and, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { db, schema } from '../db/client'
import {
  approveDeviceAuthorization,
  CLI_CLIENT_ID,
  createDeviceAuthorization,
  denyDeviceAuthorization,
  exchangeDeviceCode,
  hashCliToken,
  revokeCliToken,
  rotateRefreshToken,
} from '../lib/cli-auth'
import { resolveAuthUser } from '../lib/user-auth'
import { bffOrigin } from './oauth'

function formBody(request: Request): Promise<URLSearchParams> {
  return request.text().then((text) => new URLSearchParams(text))
}

function oauthError(error: string, status = 400): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })
}

export const cliAuthRoutes = new Elysia()
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
    if (!authUser) {
      const returnTo = `/oauth/device?user_code=${encodeURIComponent(code)}`
      const frontend = config.auth.frontendOrigin || new URL(request.url).origin
      return new Response(null, {
        status: 302,
        headers: { location: `${frontend}/login?return_to=${encodeURIComponent(returnTo)}` },
      })
    }
    const escaped = code.replace(/[<>&]/g, '')
    return new Response(
      `<html><body><h1>Authorize Muvloom CLI</h1><p>Code: ${escaped}</p><form method="post" action="/oauth/device"><input type="hidden" name="user_code" value="${escaped.replace(/"/g, '')}"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
    )
  })
  .post('/oauth/device', async ({ authUser, request }) => {
    const body = await formBody(request)
    const code = body.get('user_code') ?? ''
    if (!authUser) {
      const frontend = config.auth.frontendOrigin || new URL(request.url).origin
      const returnTo = `/oauth/device?user_code=${encodeURIComponent(code)}`
      return new Response(null, {
        status: 302,
        headers: { location: `${frontend}/login?return_to=${encodeURIComponent(returnTo)}` },
      })
    }
    const approved = body.get('decision') === 'approve'
    const changed = approved
      ? await approveDeviceAuthorization(code, authUser.id)
      : await denyDeviceAuthorization(code, authUser.id)
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
