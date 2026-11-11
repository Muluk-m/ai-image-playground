import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'
import {
  type AccountProfileView,
  deviceAuthorization,
  isSessionRefreshRequestKey,
} from '@image-playground/shared'
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { accountProfileView } from '../account-profile-view'
import { log } from '../logger'
import { isUniqueViolation } from '../user-admin'

export const CLI_CLIENT_ID = 'muvloom-cli'
export const CLI_SCOPES = ['images:read', 'images:write', 'media:read', 'media:write'] as const
export type CliScope = (typeof CLI_SCOPES)[number]

/** 用户要先去浏览器登录，再回到对话里说一声，十分钟常常不够；设备码一次性、只存哈希，放宽到 20 分钟。 */
const DEVICE_CODE_TTL_MS = 20 * 60 * 1000
const DEVICE_POLL_INTERVAL_SECONDS = 5
const SLOW_DOWN_STEP_SECONDS = 5
const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60 * 1000
/** 滚动有效期：每次刷新从当下重新算 30 天，连续使用就不会被迫重新授权。 */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LAST_USED_TOUCH_MS = 60 * 1000
/** 已兑换的设备码在到期后这么久内还能带同一请求标识重发同一组令牌，够用户修好凭据目录再重跑。 */
const DEVICE_REPLAY_GRACE_MS = 60 * 60 * 1000
/** 批准后交给本机回调的一次性授权码：CLI 就在本机等着，几秒内就会来换。 */
const AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000
/**
 * 批准后这段时间内设备码让路给回调；过了还没换，多半回不到本机，轮询接手。已批准的设备码
 * 到期后也再留这么久，临近到期才批准的登录仍有轮询窗口。
 */
const HANDBACK_MS = 30 * 1000
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

/**
 * CLI 在换令牌前持久保存的请求标识（UUID v4）。响应丢失后带同一标识重试，服务端据此推导出
 * 同一组令牌，见 ADR 0031。只存它的哈希。
 */
export type CliRequestKey = string & { readonly __cliRequestKey: unique symbol }

export function parseCliRequestKey(value: unknown): CliRequestKey | null {
  return isSessionRefreshRequestKey(value) ? (value as string as CliRequestKey) : null
}

function requestMarker(key: CliRequestKey): string {
  return hashCliSecret(key)
}

/**
 * 继任刷新令牌由前驱凭据（旧刷新令牌或设备码）、所属记录和请求标识确定性推导：
 * 只有同时持有前驱明文和标识的一方能重算出它，数据库仍然只存哈希。
 */
function successorRefresh(
  predecessor: string,
  key: CliRequestKey,
  domain: 'refresh' | 'device' | 'code',
  ownerId: string,
): string {
  const secret = createHmac('sha256', predecessor)
    .update(JSON.stringify([`cli-${domain}-successor-v1`, ownerId, key]))
    .digest('base64url')
  return `r1.${requestMarker(key)}.${secret}`
}

function successorAccess(refresh: string): string {
  return createHmac('sha256', refresh)
    .update(JSON.stringify(['cli-access-v1']))
    .digest('base64url')
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

/**
 * 本机回调登录（RFC 8252 §7.3）：回调地址只能是回环 IP 字面量上的 `/callback`，端口由 CLI
 * 临时监听决定。不接受 `localhost`，免得被 hosts 或代理改写到别处。
 */
export function parseLoopbackRedirect(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname
  if (url.protocol !== 'http:' || (host !== '127.0.0.1' && host !== '[::1]')) return null
  if (!url.port || url.pathname !== '/callback' || url.search || url.hash) return null
  if (url.username || url.password) return null
  return url.toString()
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

export function isPkceChallenge(value: string): boolean {
  return PKCE_CHALLENGE.test(value)
}

function pkceMatches(verifier: string, challenge: string | null): boolean {
  if (!challenge || !PKCE_VERIFIER.test(verifier)) return false
  return createHash('sha256').update(verifier).digest('base64url') === challenge
}

export interface LoopbackRegistration {
  readonly redirectUri: string
  readonly codeChallenge: string
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
  loopback: LoopbackRegistration | null = null,
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
        redirect_uri: loopback?.redirectUri ?? null,
        code_challenge: loopback?.codeChallenge ?? null,
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

export type DeviceDecision =
  | { readonly ok: false }
  | {
      readonly ok: true
      /** 本机回调登录：确认页带着一次性授权码跳回这里，CLI 立刻完成，不用等轮询。 */
      readonly redirectTo: string | null
    }

export async function decideDeviceAuthorization(
  code: string,
  userId: string,
  decision: 'approved' | 'denied',
  /** 确认页会把浏览器带回本机：只有 CLI 在本机打开的页面才这么说，手输授权码的不会。 */
  loopback = false,
): Promise<DeviceDecision> {
  const normalized = normalizeUserCode(code)
  if (!normalized) return { ok: false }
  const authorizationCode = token()
  const now = Date.now()
  const [changed] = await db
    .update(schema.device_authorizations)
    .set({
      status: decision,
      user_id: userId,
      // 只有登记了回调地址的授权才发授权码；没登记的照旧等 CLI 轮询。
      ...(decision === 'approved' && loopback
        ? {
            authorization_code_hash: sql`CASE WHEN ${schema.device_authorizations.redirect_uri} IS NOT NULL THEN ${hashCliSecret(authorizationCode)}::text END`,
            authorization_code_expires_at: sql`CASE WHEN ${schema.device_authorizations.redirect_uri} IS NOT NULL THEN ${new Date(now + AUTHORIZATION_CODE_TTL_MS).toISOString()}::timestamptz END`,
          }
        : {}),
    })
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
      redirectUri: schema.device_authorizations.redirect_uri,
    })
  if (!changed) return { ok: false }
  await audit(db, {
    action: `device_authorization.${decision}`,
    operatorId: userId,
    targetType: 'cli_device_authorization',
    targetId: changed.id,
    details: { client_id: changed.clientId, loopback: changed.redirectUri !== null },
  })
  if (decision !== 'approved' || !loopback || !changed.redirectUri)
    return { ok: true, redirectTo: null }
  const target = new URL(changed.redirectUri)
  target.searchParams.set('code', authorizationCode)
  return { ok: true, redirectTo: target.toString() }
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
        | 'refresh_request_completed'
    }

function issueTokens(scopes: string, now: number, refreshValue?: string) {
  const refresh = refreshValue ?? token()
  const access = refreshValue ? successorAccess(refresh) : token()
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

/**
 * 由确定性继任令牌找回仍然有效的连接，按库里记录的到期时间重发同一组令牌。连接已经轮换、
 * 吊销或过期时不恢复过时凭据。
 */
async function replaySuccessor(
  tx: Transaction,
  refresh: string,
  clientId: string,
  now: number,
): Promise<TokenGrantResult> {
  const [connection] = await tx
    .select()
    .from(schema.cli_connections)
    .where(
      and(
        eq(schema.cli_connections.refresh_token_hash, hashCliSecret(refresh)),
        eq(schema.cli_connections.client_id, clientId),
      ),
    )
    .limit(1)
  const access = successorAccess(refresh)
  if (
    !connection ||
    connection.revoked_at !== null ||
    connection.refresh_expires_at <= now ||
    connection.access_token_hash !== hashCliSecret(access)
  )
    return { ok: false, error: 'invalid_grant' }
  return {
    ok: true,
    tokens: {
      access_token: access,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: Math.max(0, Math.floor((connection.access_expires_at - now) / 1000)),
      refresh_token_expires_in: Math.floor((connection.refresh_expires_at - now) / 1000),
      scope: connection.scopes,
    },
  }
}

/**
 * RFC 8628 §3.4/3.5：轮询太快回 slow_down 并加长间隔；批准后只能换一次令牌。带请求标识
 * 兑换时，令牌由设备码与标识推导：响应丢失后同一标识重试拿回同一组令牌，不同标识按已用拒绝。
 */
export async function exchangeDeviceCode(
  deviceCode: string,
  clientId: string,
  requestKey: CliRequestKey | null = null,
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
    if (!row) return { ok: false, error: 'invalid_grant' }
    if (row.status === 'consumed')
      return requestKey && row.expires_at + DEVICE_REPLAY_GRACE_MS > now
        ? replaySuccessor(
            tx,
            successorRefresh(deviceCode, requestKey, 'device', row.id),
            clientId,
            now,
          )
        : { ok: false, error: 'invalid_grant' }
    const approvedGrace = row.status === 'approved' && row.expires_at + HANDBACK_MS > now
    if (row.expires_at <= now && !approvedGrace) return { ok: false, error: 'expired_token' }
    if (row.status === 'denied') return { ok: false, error: 'access_denied' }
    // 确认页正带着授权码回本机：回调优先，设备码在授权码有效期内仍按等待处理，否则 CLI
    // 轮询先拿到令牌退出，浏览器回到的就是已经关掉的端口。授权码过期没人用，轮询照常兜底。
    const handingBack =
      row.status === 'approved' &&
      row.authorization_code_hash !== null &&
      row.authorization_code_expires_at !== null &&
      row.authorization_code_expires_at - AUTHORIZATION_CODE_TTL_MS + HANDBACK_MS > now
    if (row.status === 'pending' || handingBack) {
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
    return createConnection(
      tx,
      row,
      row.user_id,
      now,
      requestKey ? successorRefresh(deviceCode, requestKey, 'device', row.id) : undefined,
      'device_code',
    )
  })
}

/** 同一次设备授权换出的连接：设备码轮询与本机回调授权码两条路共用这一段。 */
async function createConnection(
  tx: Transaction,
  row: typeof schema.device_authorizations.$inferSelect,
  userId: string,
  now: number,
  refresh: string | undefined,
  via: 'device_code' | 'authorization_code',
): Promise<TokenGrantResult> {
  if (!deviceAuthorization.allows(row.status, 'consume')) {
    return { ok: false, error: 'invalid_grant' }
  }
  const next = deviceAuthorization.step(row.status, 'consume')
  const [updated] = await tx
    .update(schema.device_authorizations)
    .set({ status: next, last_polled_at: now })
    .where(
      and(
        eq(schema.device_authorizations.id, row.id),
        eq(schema.device_authorizations.status, 'approved'),
      ),
    )
    .returning({ id: schema.device_authorizations.id })
  if (!updated) return { ok: false, error: 'invalid_grant' }
  const issued = issueTokens(row.scopes, now, refresh)
  const connectionId = randomUUID()
  await tx.insert(schema.cli_connections).values({
    id: connectionId,
    user_id: userId,
    client_id: row.client_id,
    scopes: row.scopes,
    ...issued.columns,
    created_at: now,
    last_used_at: now,
    revoked_at: null,
  })
  await audit(tx, {
    action: 'token.issued',
    operatorId: userId,
    targetType: 'cli_connection',
    targetId: connectionId,
    details: { client_id: row.client_id, scopes: row.scopes, grant: via },
  })
  return { ok: true, tokens: issued.response }
}

/**
 * 本机回调登录的授权码兑换（RFC 6749 §4.1.3 + RFC 7636）。授权码一次性、两分钟有效，绑定
 * 登记时的回调地址与 PKCE challenge；带请求标识时令牌由 verifier 与标识推导，响应丢失后同一
 * 授权码、verifier 与标识重试重发同一组令牌。
 */
export async function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  requestKey: CliRequestKey | null = null,
): Promise<TokenGrantResult> {
  const now = Date.now()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.device_authorizations)
      .where(
        and(
          eq(schema.device_authorizations.authorization_code_hash, hashCliSecret(code)),
          eq(schema.device_authorizations.client_id, clientId),
        ),
      )
      .for('update')
      .limit(1)
    if (
      !row ||
      row.redirect_uri !== redirectUri ||
      row.authorization_code_expires_at === null ||
      !pkceMatches(codeVerifier, row.code_challenge)
    )
      return { ok: false, error: 'invalid_grant' }
    const refresh = requestKey
      ? successorRefresh(codeVerifier, requestKey, 'code', row.id)
      : undefined
    if (row.status === 'consumed')
      return refresh && row.authorization_code_expires_at + DEVICE_REPLAY_GRACE_MS > now
        ? replaySuccessor(tx, refresh, clientId, now)
        : { ok: false, error: 'invalid_grant' }
    if (row.status !== 'approved' || !row.user_id || row.authorization_code_expires_at <= now)
      return { ok: false, error: 'invalid_grant' }
    return createConnection(tx, row, row.user_id, now, refresh, 'authorization_code')
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
 * 刷新时在同一行上轮换令牌，旧刷新令牌记进 retired 表。
 *
 * 带请求标识（新 CLI）：继任令牌由旧令牌与标识推导，响应丢失后同一旧令牌带同一标识重试，
 * 重发同一组令牌；证明不了的旧令牌只拒绝，不吊销仍然有效的连接。不带标识（旧 CLI）：旧令牌
 * 再次出现说明被复制过，按 OAuth 2.1 §4.3.1 吊销整条连接——但被新 CLI 轮换掉的令牌不走
 * 这条，否则持有旧令牌的一方去掉标识就能踢掉健康连接。
 */
export async function refreshCliToken(
  refreshToken: string,
  clientId: string,
  requestKey: CliRequestKey | null = null,
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
      // 不锁退休行：轮换事务先锁连接再清理退休行，这里也只锁连接，加锁顺序一致。
      const [retired] = await tx
        .select({
          requestKeyHash: schema.cli_retired_refresh_tokens.request_key_hash,
          connectionId: schema.cli_retired_refresh_tokens.connection_id,
        })
        .from(schema.cli_retired_refresh_tokens)
        .where(eq(schema.cli_retired_refresh_tokens.token_hash, hash))
        .limit(1)
      if (!retired) return { ok: false, error: 'invalid_grant' }
      const [connection] = await tx
        .select()
        .from(schema.cli_connections)
        .where(
          and(
            eq(schema.cli_connections.id, retired.connectionId),
            eq(schema.cli_connections.client_id, clientId),
          ),
        )
        .for('update')
        .limit(1)
      if (!connection) return { ok: false, error: 'invalid_grant' }
      if (requestKey) {
        const replayed = await replaySuccessor(
          tx,
          successorRefresh(refreshToken, requestKey, 'refresh', connection.id),
          clientId,
          now,
        )
        if (replayed.ok) return replayed
      }
      // 退休行没有标识，说明作废它的那次轮换不是新 CLI 做的；新 CLI 自己的重试总带标识。
      // 这正是令牌被复制的信号，吊销整条连接。退休行有标识而这次证明不了的，只拒绝：
      // 持有旧令牌的一方不能借此踢掉健康连接。
      if (retired.requestKeyHash === null && connection.revoked_at === null) {
        await revokeConnection(tx, connection, 'cli', 'refresh_token_reuse')
      } else if (connection.revoked_at === null) {
        await audit(tx, {
          action: 'token.retired_rejected',
          operatorId: 'cli',
          targetType: 'cli_connection',
          targetId: connection.id,
          details: { client_id: connection.client_id, with_request_id: requestKey !== null },
        })
        log.warn(
          { event: 'cli.refresh.retired_rejected', connectionId: connection.id },
          'retired cli refresh rejected',
        )
      }
      return { ok: false, error: 'invalid_grant' }
    }
    if (row.revoked_at !== null || row.refresh_expires_at <= now)
      return { ok: false, error: 'invalid_grant' }
    if (requestKey) {
      // 这个标识已经在本连接上完成过一次轮换：当前令牌仍然有效，CLI 换个新标识再刷新即可，
      // 不能拿已完成的标识推进更新一代令牌。
      const [used] = await tx
        .select({ hash: schema.cli_retired_refresh_tokens.token_hash })
        .from(schema.cli_retired_refresh_tokens)
        .where(
          and(
            eq(schema.cli_retired_refresh_tokens.connection_id, row.id),
            eq(schema.cli_retired_refresh_tokens.request_key_hash, requestMarker(requestKey)),
          ),
        )
        .limit(1)
      if (used) return { ok: false, error: 'refresh_request_completed' }
    }
    const issued = issueTokens(
      row.scopes,
      now,
      requestKey ? successorRefresh(refreshToken, requestKey, 'refresh', row.id) : undefined,
    )
    await tx.insert(schema.cli_retired_refresh_tokens).values({
      token_hash: hash,
      connection_id: row.id,
      request_key_hash: requestKey ? requestMarker(requestKey) : null,
      retired_at: now,
    })
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
