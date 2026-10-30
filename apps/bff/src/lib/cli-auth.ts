import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { AuthUserView } from '@image-playground/shared'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { db, schema } from '../db/client'
import { accountProfileView } from './account-profile-view'

export const CLI_CLIENT_ID = 'muvloom-cli'
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000
export const DEVICE_POLL_INTERVAL_SECONDS = 5
export const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function hashCliToken(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function secret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export interface DeviceAuthorizationResult {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export async function createDeviceAuthorization(
  clientId: string,
  verificationUri: string,
): Promise<DeviceAuthorizationResult | null> {
  const [client] = await db
    .select({ id: schema.oauth_clients.id })
    .from(schema.oauth_clients)
    .where(eq(schema.oauth_clients.id, clientId))
    .limit(1)
  if (!client) return null
  const deviceCode = secret()
  const userCode =
    `${secret(5).replace(/[-_]/g, '').slice(0, 4)}-${secret(5).replace(/[-_]/g, '').slice(0, 4)}`.toUpperCase()
  const now = Date.now()
  await db.insert(schema.device_authorizations).values({
    id: randomUUID(),
    client_id: clientId,
    device_code_hash: hashCliToken(deviceCode),
    user_code_hash: hashCliToken(userCode),
    status: 'pending',
    user_id: null,
    expires_at: now + DEVICE_CODE_TTL_MS,
    interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
    last_polled_at: null,
    created_at: now,
  })
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_CODE_TTL_MS / 1000,
    interval: DEVICE_POLL_INTERVAL_SECONDS,
  }
}

export async function approveDeviceAuthorization(
  userCode: string,
  userId: string,
): Promise<boolean> {
  const now = Date.now()
  const changed = await db
    .update(schema.device_authorizations)
    .set({ status: 'approved', user_id: userId })
    .where(
      and(
        eq(schema.device_authorizations.user_code_hash, hashCliToken(userCode)),
        eq(schema.device_authorizations.status, 'pending'),
        gt(schema.device_authorizations.expires_at, now),
      ),
    )
    .returning({ id: schema.device_authorizations.id })
  return changed.length > 0
}
export async function denyDeviceAuthorization(userCode: string, userId: string): Promise<boolean> {
  const now = Date.now()
  const changed = await db
    .update(schema.device_authorizations)
    .set({ status: 'denied', user_id: userId })
    .where(
      and(
        eq(schema.device_authorizations.user_code_hash, hashCliToken(userCode)),
        eq(schema.device_authorizations.status, 'pending'),
        gt(schema.device_authorizations.expires_at, now),
      ),
    )
    .returning({ id: schema.device_authorizations.id })
  return changed.length > 0
}

export async function exchangeDeviceCode(
  deviceCode: string,
  clientId: string,
): Promise<{ ok: true; tokens: Record<string, unknown> } | { ok: false; error: string }> {
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.device_authorizations)
      .where(
        and(
          eq(schema.device_authorizations.device_code_hash, hashCliToken(deviceCode)),
          eq(schema.device_authorizations.client_id, clientId),
        ),
      )
      .for('update')
      .limit(1)
    if (!row || row.expires_at <= now || row.status === 'expired') {
      if (row && row.status !== 'expired')
        await tx
          .update(schema.device_authorizations)
          .set({ status: 'expired' })
          .where(eq(schema.device_authorizations.id, row.id))
      return { ok: false, error: 'expired_token' }
    }
    if (row.status === 'denied') return { ok: false, error: 'access_denied' }
    if (row.status === 'pending') {
      const elapsed = row.last_polled_at == null ? Infinity : now - row.last_polled_at
      if (elapsed < row.interval_seconds * 1000) {
        await tx
          .update(schema.device_authorizations)
          .set({ interval_seconds: row.interval_seconds + 5, last_polled_at: now })
          .where(eq(schema.device_authorizations.id, row.id))
        return { ok: false, error: 'slow_down' }
      }
      await tx
        .update(schema.device_authorizations)
        .set({ last_polled_at: now })
        .where(eq(schema.device_authorizations.id, row.id))
      return { ok: false, error: 'authorization_pending' }
    }
    if (!row.user_id) return { ok: false, error: 'authorization_pending' }
    await tx
      .update(schema.device_authorizations)
      .set({ status: 'expired', last_polled_at: now })
      .where(eq(schema.device_authorizations.id, row.id))
    const access = secret()
    const refresh = secret()
    await tx.insert(schema.cli_connections).values({
      id: randomUUID(),
      user_id: row.user_id,
      client_id: row.client_id,
      family_id: randomUUID(),
      access_token_hash: hashCliToken(access),
      refresh_token_hash: hashCliToken(refresh),
      access_expires_at: now + ACCESS_TOKEN_TTL_MS,
      refresh_expires_at: now + REFRESH_TOKEN_TTL_MS,
      created_at: now,
      last_used_at: now,
      revoked_at: null,
    })
    return {
      ok: true,
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        refresh_token_expires_in: REFRESH_TOKEN_TTL_MS / 1000,
      },
    }
  })
}

export async function rotateRefreshToken(
  refreshToken: string,
  clientId: string,
): Promise<{ ok: true; tokens: Record<string, unknown> } | { ok: false; error: string }> {
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.cli_connections)
      .where(
        and(
          eq(schema.cli_connections.refresh_token_hash, hashCliToken(refreshToken)),
          eq(schema.cli_connections.client_id, clientId),
        ),
      )
      .for('update')
      .limit(1)
    if (!row) return { ok: false, error: 'invalid_grant' }
    if (row.revoked_at !== null) {
      await tx
        .update(schema.cli_connections)
        .set({ revoked_at: now })
        .where(eq(schema.cli_connections.family_id, row.family_id))
      return { ok: false, error: 'invalid_grant' }
    }
    if (row.refresh_expires_at <= now) return { ok: false, error: 'invalid_grant' }
    const access = secret()
    const refresh = secret()
    await tx
      .update(schema.cli_connections)
      .set({ revoked_at: now, last_used_at: now })
      .where(eq(schema.cli_connections.id, row.id))
    await tx.insert(schema.cli_connections).values({
      id: randomUUID(),
      user_id: row.user_id,
      client_id: row.client_id,
      family_id: row.family_id,
      access_token_hash: hashCliToken(access),
      refresh_token_hash: hashCliToken(refresh),
      access_expires_at: now + ACCESS_TOKEN_TTL_MS,
      refresh_expires_at: row.refresh_expires_at,
      created_at: now,
      last_used_at: now,
      revoked_at: null,
    })
    return {
      ok: true,
      tokens: {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_MS / 1000,
        refresh_token_expires_in: Math.max(0, Math.floor((row.refresh_expires_at - now) / 1000)),
      },
    }
  })
}

export async function revokeCliToken(token: string, clientId: string): Promise<void> {
  const hash = hashCliToken(token)
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ family_id: schema.cli_connections.family_id })
      .from(schema.cli_connections)
      .where(
        and(
          eq(schema.cli_connections.client_id, clientId),
          or(
            eq(schema.cli_connections.access_token_hash, hash),
            eq(schema.cli_connections.refresh_token_hash, hash),
          ),
        ),
      )
      .limit(1)
    if (row)
      await tx
        .update(schema.cli_connections)
        .set({ revoked_at: Date.now() })
        .where(eq(schema.cli_connections.family_id, row.family_id))
  })
}

export async function resolveCliBearerToken(token: string): Promise<AuthUserView | null> {
  if (!token) return null
  const now = Date.now()
  const [row] = await db
    .select({ connection: schema.cli_connections, user: schema.users })
    .from(schema.cli_connections)
    .innerJoin(schema.users, eq(schema.users.id, schema.cli_connections.user_id))
    .where(
      and(
        eq(schema.cli_connections.access_token_hash, hashCliToken(token)),
        isNull(schema.cli_connections.revoked_at),
        gt(schema.cli_connections.access_expires_at, now),
      ),
    )
    .limit(1)
  if (!row || row.user.status !== 'active') return null
  void db
    .update(schema.cli_connections)
    .set({ last_used_at: now })
    .where(eq(schema.cli_connections.id, row.connection.id))
  return accountProfileView(row.user)
}

export const requireCliBearer = new Elysia({ name: 'require-cli-bearer' })
  .derive({ as: 'scoped' }, async ({ request }) => {
    const header = request.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    return { cliAuthUser: await resolveCliBearerToken(token) }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ cliAuthUser, status }) =>
    cliAuthUser ? undefined : status(401, { error: 'unauthorized' }),
  )
