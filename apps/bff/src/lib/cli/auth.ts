import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { AccountProfileView } from '@image-playground/shared'
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { accountProfileView } from '../account-profile-view'
import { log } from '../logger'
import { isUniqueViolation } from '../user-admin'

export const CLI_CLIENT_ID = 'muvloom-cli'
export const CLI_SCOPES = ['images:read', 'images:write', 'media:read', 'media:write'] as const
export type CliScope = (typeof CLI_SCOPES)[number]

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000
const DEVICE_POLL_INTERVAL_SECONDS = 5
const SLOW_DOWN_STEP_SECONDS = 5
const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000
/** 滚动有效期：每次刷新从当下重新算 30 天，连续使用就不会被迫重新授权。 */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LAST_USED_TOUCH_MS = 60 * 1000
/** 过期设备码留一天供排查，之后在下一次创建时顺手删掉。 */
const DEVICE_ROW_RETENTION_MS = 24 * 60 * 60 * 1000

/** RFC 8628 §6.1 推荐：去掉元音和易混字符，人工抄写不易出错。 */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function hashCliSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function token(): string {
  return randomBytes(32).toString('base64url')
}

function userCode(): string {
  const letters = Array.from(
    { length: 8 },
    () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)],
  )
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
}

/** 用户手输的码：大小写、空格、连字符都容忍，再按标准格式比对。 */
export function normalizeUserCode(input: string): string {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '')
  return letters.length === 8 ? `${letters.slice(0, 4)}-${letters.slice(4)}` : ''
}

async function audit(
  database: Pick<typeof db, 'insert'>,
  input: {
    action: string
    operatorId: string
    targetType: 'cli_connection' | 'cli_device_authorization'
    targetId: string
    details?: Record<string, unknown>
  },
) {
  await database.insert(schema.operator_audits).values({
    id: randomUUID(),
    operator_id: input.operatorId,
    action: `cli.${input.action}`,
    target_type: input.targetType,
    target_id: input.targetId,
    details: input.details ?? {},
    created_at: Date.now(),
  })
}

export interface DeviceAuthorization {
  readonly device_code: string
  readonly user_code: string
  readonly verification_uri: string
  readonly verification_uri_complete: string
  readonly expires_in: number
  readonly interval: number
}

export async function createDeviceAuthorization(
  clientId: string,
  verificationUri: string,
): Promise<DeviceAuthorization | null> {
  const [client] = await db
    .select({ id: schema.oauth_clients.id })
    .from(schema.oauth_clients)
    .where(eq(schema.oauth_clients.id, clientId))
    .limit(1)
  if (!client) return null
  const now = Date.now()
  await db
    .delete(schema.device_authorizations)
    .where(lt(schema.device_authorizations.expires_at, now - DEVICE_ROW_RETENTION_MS))
  // 作废的刷新令牌要留到连接失效为止，重放检测才覆盖连接的整个生命周期；连接吊销或过期后
  // 就没有可吊销的东西了，此时连同记录一起清掉。挂在新登录上顺手做，表不会无界增长。
  await db.delete(schema.cli_retired_refresh_tokens).where(
    inArray(
      schema.cli_retired_refresh_tokens.connection_id,
      db
        .select({ id: schema.cli_connections.id })
        .from(schema.cli_connections)
        .where(
          or(
            isNotNull(schema.cli_connections.revoked_at),
            lt(schema.cli_connections.refresh_expires_at, now - DEVICE_ROW_RETENTION_MS),
          ),
        ),
    ),
  )
  const deviceCode = token()
  // 8 位、20 个字母约 2.6e10 种组合，撞上未过期的码概率极低；撞了就换一个重试。
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = userCode()
    const id = randomUUID()
    try {
      await db.insert(schema.device_authorizations).values({
        id,
        client_id: clientId,
        device_code_hash: hashCliSecret(deviceCode),
        user_code_hash: hashCliSecret(code),
        status: 'pending',
        scopes: CLI_SCOPES.join(' '),
        user_id: null,
        expires_at: now + DEVICE_CODE_TTL_MS,
        interval_seconds: DEVICE_POLL_INTERVAL_SECONDS,
        last_polled_at: null,
        created_at: now,
      })
    } catch (error) {
      if (isUniqueViolation(error)) continue
      throw error
    }
    await audit(db, {
      action: 'device_authorization.created',
      operatorId: 'cli',
      targetType: 'cli_device_authorization',
      targetId: id,
      details: { client_id: clientId },
    })
    const complete = new URL(verificationUri)
    complete.searchParams.set('user_code', code)
    return {
      device_code: deviceCode,
      user_code: code,
      verification_uri: verificationUri,
      verification_uri_complete: complete.toString(),
      expires_in: DEVICE_CODE_TTL_MS / 1000,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    }
  }
  throw new Error('device user code collision')
}

export interface PendingDeviceAuthorization {
  readonly client_name: string
  readonly scopes: readonly string[]
  readonly expires_at: number
}

/** 确认页展示用：只有还在等待确认、没过期的码才返回内容。 */
export async function describeDeviceAuthorization(
  code: string,
): Promise<PendingDeviceAuthorization | null> {
  const normalized = normalizeUserCode(code)
  if (!normalized) return null
  const [row] = await db
    .select({
      clientName: schema.oauth_clients.name,
      scopes: schema.device_authorizations.scopes,
      expiresAt: schema.device_authorizations.expires_at,
    })
    .from(schema.device_authorizations)
    .innerJoin(
      schema.oauth_clients,
      eq(schema.oauth_clients.id, schema.device_authorizations.client_id),
    )
    .where(
      and(
        eq(schema.device_authorizations.user_code_hash, hashCliSecret(normalized)),
        eq(schema.device_authorizations.status, 'pending'),
        gt(schema.device_authorizations.expires_at, Date.now()),
      ),
    )
    .limit(1)
  return row
    ? { client_name: row.clientName, scopes: row.scopes.split(' '), expires_at: row.expiresAt }
    : null
}

export async function decideDeviceAuthorization(
  code: string,
  userId: string,
  decision: 'approved' | 'denied',
): Promise<boolean> {
  const normalized = normalizeUserCode(code)
  if (!normalized) return false
  const [changed] = await db
    .update(schema.device_authorizations)
    .set({ status: decision, user_id: userId })
    .where(
      and(
        eq(schema.device_authorizations.user_code_hash, hashCliSecret(normalized)),
        eq(schema.device_authorizations.status, 'pending'),
        gt(schema.device_authorizations.expires_at, Date.now()),
      ),
    )
    .returning({
      id: schema.device_authorizations.id,
      clientId: schema.device_authorizations.client_id,
    })
  if (!changed) return false
  await audit(db, {
    action: `device_authorization.${decision}`,
    operatorId: userId,
    targetType: 'cli_device_authorization',
    targetId: changed.id,
    details: { client_id: changed.clientId },
  })
  return true
}

export interface CliTokenResponse {
  readonly access_token: string
  readonly refresh_token: string
  readonly token_type: 'Bearer'
  readonly expires_in: number
  readonly refresh_token_expires_in: number
  readonly scope: string
}

export type TokenGrantResult =
  | { readonly ok: true; readonly tokens: CliTokenResponse }
  | {
      readonly ok: false
      readonly error:
        | 'authorization_pending'
        | 'slow_down'
        | 'access_denied'
        | 'expired_token'
        | 'invalid_grant'
    }

function issueTokens(scopes: string, now: number) {
  const access = token()
  const refresh = token()
  return {
    columns: {
      access_token_hash: hashCliSecret(access),
      access_expires_at: now + ACCESS_TOKEN_TTL_MS,
      refresh_token_hash: hashCliSecret(refresh),
      refresh_expires_at: now + REFRESH_TOKEN_TTL_MS,
    },
    response: {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer' as const,
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token_expires_in: REFRESH_TOKEN_TTL_MS / 1000,
      scope: scopes,
    },
  }
}

/** RFC 8628 §3.4/3.5：轮询太快回 slow_down 并加长间隔；批准后只能换一次令牌。 */
export async function exchangeDeviceCode(
  deviceCode: string,
  clientId: string,
): Promise<TokenGrantResult> {
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.device_authorizations)
      .where(
        and(
          eq(schema.device_authorizations.device_code_hash, hashCliSecret(deviceCode)),
          eq(schema.device_authorizations.client_id, clientId),
        ),
      )
      .for('update')
      .limit(1)
    if (!row || row.status === 'consumed') return { ok: false, error: 'invalid_grant' }
    if (row.expires_at <= now) return { ok: false, error: 'expired_token' }
    if (row.status === 'denied') return { ok: false, error: 'access_denied' }
    if (row.status === 'pending') {
      const tooSoon =
        row.last_polled_at !== null && now - row.last_polled_at < row.interval_seconds * 1000
      await tx
        .update(schema.device_authorizations)
        .set({
          last_polled_at: now,
          ...(tooSoon ? { interval_seconds: row.interval_seconds + SLOW_DOWN_STEP_SECONDS } : {}),
        })
        .where(eq(schema.device_authorizations.id, row.id))
      return { ok: false, error: tooSoon ? 'slow_down' : 'authorization_pending' }
    }
    if (!row.user_id) return { ok: false, error: 'invalid_grant' }
    await tx
      .update(schema.device_authorizations)
      .set({ status: 'consumed', last_polled_at: now })
      .where(eq(schema.device_authorizations.id, row.id))
    const issued = issueTokens(row.scopes, now)
    const connectionId = randomUUID()
    await tx.insert(schema.cli_connections).values({
      id: connectionId,
      user_id: row.user_id,
      client_id: row.client_id,
      scopes: row.scopes,
      ...issued.columns,
      created_at: now,
      last_used_at: now,
      revoked_at: null,
    })
    await audit(tx, {
      action: 'token.issued',
      operatorId: row.user_id,
      targetType: 'cli_connection',
      targetId: connectionId,
      details: { client_id: row.client_id, scopes: row.scopes },
    })
    return { ok: true, tokens: issued.response }
  })
}

async function revokeConnection(
  tx: Transaction,
  connection: { id: string; user_id: string; client_id: string },
  operatorId: string,
  reason: string,
) {
  await tx
    .update(schema.cli_connections)
    .set({ revoked_at: Date.now() })
    .where(
      and(eq(schema.cli_connections.id, connection.id), isNull(schema.cli_connections.revoked_at)),
    )
  await audit(tx, {
    action: 'connection.revoked',
    operatorId,
    targetType: 'cli_connection',
    targetId: connection.id,
    details: { client_id: connection.client_id, reason },
  })
}

/**
 * 刷新时在同一行上轮换令牌，旧刷新令牌记进 retired 表。旧令牌再次出现说明被复制过，
 * 按 OAuth 2.1 §4.3.1 吊销整条连接。
 */
export async function refreshCliToken(
  refreshToken: string,
  clientId: string,
): Promise<TokenGrantResult> {
  const now = Date.now()
  const hash = hashCliSecret(refreshToken)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.cli_connections)
      .where(
        and(
          eq(schema.cli_connections.refresh_token_hash, hash),
          eq(schema.cli_connections.client_id, clientId),
        ),
      )
      .for('update')
      .limit(1)
    if (!row) {
      const [retired] = await tx
        .select({ connection: schema.cli_connections })
        .from(schema.cli_retired_refresh_tokens)
        .innerJoin(
          schema.cli_connections,
          eq(schema.cli_connections.id, schema.cli_retired_refresh_tokens.connection_id),
        )
        .where(eq(schema.cli_retired_refresh_tokens.token_hash, hash))
        .limit(1)
      if (retired && retired.connection.revoked_at === null)
        await revokeConnection(tx, retired.connection, 'cli', 'refresh_token_reuse')
      return { ok: false, error: 'invalid_grant' }
    }
    if (row.revoked_at !== null || row.refresh_expires_at <= now)
      return { ok: false, error: 'invalid_grant' }
    const issued = issueTokens(row.scopes, now)
    await tx
      .insert(schema.cli_retired_refresh_tokens)
      .values({ token_hash: hash, connection_id: row.id, retired_at: now })
    // 刷新令牌自身 30 天就过期：比这更老的作废令牌即使被盗也换不到东西，不需要再为它做
    // 重放检测。按连接清理，活跃连接的记录数也有界。
    await tx
      .delete(schema.cli_retired_refresh_tokens)
      .where(
        and(
          eq(schema.cli_retired_refresh_tokens.connection_id, row.id),
          lt(schema.cli_retired_refresh_tokens.retired_at, now - REFRESH_TOKEN_TTL_MS),
        ),
      )

    await tx
      .update(schema.cli_connections)
      .set({ ...issued.columns, last_used_at: now })
      .where(eq(schema.cli_connections.id, row.id))
    return { ok: true, tokens: issued.response }
  })
}

/** RFC 7009：令牌不存在也按成功处理，不让调用方借此探测令牌。 */
export async function revokeCliToken(value: string, clientId: string): Promise<void> {
  const hash = hashCliSecret(value)
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
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
      .for('update')
      .limit(1)
    if (row && row.revoked_at === null) await revokeConnection(tx, row, row.user_id, 'logout')
  })
}

export interface CliConnection {
  readonly id: string
  readonly user: AccountProfileView
  readonly scopes: readonly string[]
}

/** 每个请求只查这一次：吊销、过期、账号停用都在这里拒绝。 */
export async function resolveCliConnection(accessToken: string): Promise<CliConnection | null> {
  if (!accessToken) return null
  const now = Date.now()
  const [row] = await db
    .select({
      id: schema.cli_connections.id,
      scopes: schema.cli_connections.scopes,
      lastUsedAt: schema.cli_connections.last_used_at,
      user: schema.users,
    })
    .from(schema.cli_connections)
    .innerJoin(schema.users, eq(schema.users.id, schema.cli_connections.user_id))
    .where(
      and(
        eq(schema.cli_connections.access_token_hash, hashCliSecret(accessToken)),
        isNull(schema.cli_connections.revoked_at),
        gt(schema.cli_connections.access_expires_at, now),
      ),
    )
    .limit(1)
  if (!row || row.user.status !== 'active') return null
  if (row.lastUsedAt === null || now - row.lastUsedAt > LAST_USED_TOUCH_MS) {
    db.update(schema.cli_connections)
      .set({ last_used_at: now })
      .where(eq(schema.cli_connections.id, row.id))
      .catch((err: unknown) =>
        log.warn({ event: 'cli.connection_touch_failed', err }, 'cli connection touch failed'),
      )
  }
  return { id: row.id, user: accountProfileView(row.user), scopes: row.scopes.split(' ') }
}

export interface CliConnectionSummary {
  readonly id: string
  readonly client_name: string
  readonly created_at: number
  readonly last_used_at: number | null
}

/** 账号设置里的「已连接的 CLI」：只列仍然有效的连接。 */
export async function listCliConnections(userId: string): Promise<CliConnectionSummary[]> {
  const rows = await db
    .select({
      id: schema.cli_connections.id,
      clientName: schema.oauth_clients.name,
      createdAt: schema.cli_connections.created_at,
      lastUsedAt: schema.cli_connections.last_used_at,
    })
    .from(schema.cli_connections)
    .innerJoin(schema.oauth_clients, eq(schema.oauth_clients.id, schema.cli_connections.client_id))
    .where(
      and(
        eq(schema.cli_connections.user_id, userId),
        isNull(schema.cli_connections.revoked_at),
        gt(schema.cli_connections.refresh_expires_at, Date.now()),
      ),
    )
  return rows.map((row) => ({
    id: row.id,
    client_name: row.clientName,
    created_at: row.createdAt,
    last_used_at: row.lastUsedAt,
  }))
}

export async function revokeCliConnection(userId: string, connectionId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.cli_connections)
      .where(
        and(
          eq(schema.cli_connections.id, connectionId),
          eq(schema.cli_connections.user_id, userId),
          isNull(schema.cli_connections.revoked_at),
        ),
      )
      .for('update')
      .limit(1)
    if (!row) return false
    await revokeConnection(tx, row, userId, 'account_settings')
    return true
  })
}
