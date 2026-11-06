import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import {
  type AccountSessionView,
  type AuthUserView,
  type SessionRefreshRequestKey,
  USER_REFRESH_COOKIE,
  USER_SESSION_COOKIE,
  USER_SESSION_HINT_COOKIE,
} from '@image-playground/shared'
import { and, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { accountProfileView } from './account-profile-view'
import { endStageAuthorizationsForUser } from './agent/stage-authorizations'
import { deviceLabel } from './device-label'
import { clientAddress } from './http'
import { log } from './logger'

export type SessionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export { USER_REFRESH_COOKIE, USER_SESSION_COOKIE }
/** 登出路径。会话解析要认出它，避免先删掉禁用账号的会话。 */
export const USER_LOGOUT_PATH = '/api/auth/logout'
/** 网页 access。每次请求都查库，吊销立刻生效。 */
export const USER_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 网页 refresh 的滑动窗口：每次成功刷新从当下重算。 */
export const USER_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** 从登录（旧会话则从原 created_at）起的绝对上限，到点不再续。 */
export const USER_SESSION_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1000
/** 不带幂等证明的旧客户端在这段时间内收到并发提示。 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000
/** 活跃会话不在每个请求上写库；超过这个间隔才刷新最后活跃时间和设备。 */
export const SESSION_ACTIVITY_TOUCH_MS = 5 * 60 * 1000

const USER_AGENT_MAX_LENGTH = 512
const CLIENT_IP_MAX_LENGTH = 128

export interface SessionClient {
  readonly userAgent: string | null
  readonly ip: string | null
}

export function sessionClientFromRequest(
  request: Request,
  peerAddress: string | null,
): SessionClient {
  const userAgent = request.headers.get('user-agent')?.replace(/\s+/g, ' ').trim() ?? ''
  const address = clientAddress(request, peerAddress)
  return {
    userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : null,
    ip: address === 'unknown' ? null : address.slice(0, CLIENT_IP_MAX_LENGTH),
  }
}

const SESSION_COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

const REFRESH_COOKIE_BASE = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/api/auth',
} as const

const HINT_COOKIE_BASE = {
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

interface MutableCookie {
  set(options: Record<string, unknown> & { value: string }): void
}

export interface IssuedWebSession {
  readonly accessToken: string
  readonly refreshToken: string
  readonly accessExpiresAt: number
  readonly refreshExpiresAt: number
}

function cookieMaxAge(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000))
}

/**
 * Every route that signs a user in must issue the identical cookie scope.
 * 会话 cookie 必须先写：调用方用第一条 Set-Cookie 取 token。
 */
export function setUserSessionCookie(
  jar: Record<string, MutableCookie>,
  issued: IssuedWebSession,
): void {
  const now = Date.now()
  jar[USER_SESSION_COOKIE]?.set({
    ...SESSION_COOKIE_BASE,
    value: issued.accessToken,
    maxAge: cookieMaxAge(issued.accessExpiresAt, now),
  })
  jar[USER_REFRESH_COOKIE]?.set({
    ...REFRESH_COOKIE_BASE,
    value: issued.refreshToken,
    maxAge: cookieMaxAge(issued.refreshExpiresAt, now),
  })
  jar[USER_SESSION_HINT_COOKIE]?.set({
    ...HINT_COOKIE_BASE,
    value: '1',
    maxAge: cookieMaxAge(issued.refreshExpiresAt, now),
  })
}

export function clearUserSessionCookie(jar: Record<string, MutableCookie>): void {
  jar[USER_SESSION_COOKIE]?.set({ ...SESSION_COOKIE_BASE, value: '', maxAge: 0 })
  jar[USER_REFRESH_COOKIE]?.set({ ...REFRESH_COOKIE_BASE, value: '', maxAge: 0 })
  jar[USER_SESSION_HINT_COOKIE]?.set({ ...HINT_COOKIE_BASE, value: '', maxAge: 0 })
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

function cappedExpiry(now: number, ttlMs: number, absoluteExpiresAt: number): number {
  return Math.min(now + ttlMs, absoluteExpiresAt)
}

/** 登录、注册、OAuth 签发一对令牌。库里只留哈希。 */
export async function issueUserSession(
  userId: string,
  tx: SessionTransaction,
  client?: SessionClient | null,
  now = Date.now(),
): Promise<IssuedWebSession> {
  // 成功登录时顺手清理过期 access，以及已经作废或越过绝对上限的链留下的旧 refresh 哈希。
  await tx.delete(schema.user_sessions).where(lte(schema.user_sessions.expires_at, now))
  await tx.delete(schema.user_retired_refresh_tokens).where(
    inArray(
      schema.user_retired_refresh_tokens.family_id,
      tx
        .select({ id: schema.user_session_families.id })
        .from(schema.user_session_families)
        .where(
          or(
            isNotNull(schema.user_session_families.revoked_at),
            lte(schema.user_session_families.absolute_expires_at, now),
          ),
        ),
    ),
  )
  const absoluteExpiresAt = now + USER_SESSION_ABSOLUTE_TTL_MS
  return insertFamily(tx, {
    userId,
    createdAt: now,
    absoluteExpiresAt,
    now,
    client,
    retiringHash: null,
  })
}

/** 测试和仍只需要 access 的调用方。refresh 明文丢弃，链照样建好。 */
export async function createUserSession(
  userId: string,
  tx: SessionTransaction,
  client?: SessionClient | null,
): Promise<string> {
  return (await issueUserSession(userId, tx, client)).accessToken
}

/**
 * 登出收回阶段授权时用。过期会话返回空，不要求账号仍是 active。
 * 不像 resolveUserSession 那样在账号被禁用时先删掉会话。
 */
export async function resolveSessionUserId(token: string): Promise<string | null> {
  if (!token) return null
  const [row] = await db
    .select({
      user_id: schema.user_sessions.user_id,
      expires_at: schema.user_sessions.expires_at,
    })
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
    .limit(1)
  if (!row || row.expires_at <= Date.now()) return null
  return row.user_id
}

/**
 * 登录或注册换成了另一个账号、却没先登出：旧账号还开着的阶段授权在这里收回。
 * 浏览器换了 cookie 之后，旧账号的运行再也收不了尾（`/end` 会以新账号的身份被拒）。
 * 和登出一样是尽力而为：失败只记日志，不挡这次登录。同一账号重新登录不收回。
 */
export async function reclaimSwitchedAccount(
  previousToken: unknown,
  nextUserId: string,
): Promise<void> {
  if (typeof previousToken !== 'string' || !previousToken) return
  try {
    const previous = await resolveSessionUserId(previousToken)
    if (!previous || previous === nextUserId) return
    await endStageAuthorizationsForUser(previous)
  } catch (error) {
    log.warn(
      { err: error, event: 'auth.switch.reclaim_failed' },
      'stage authorization reclaim failed while switching accounts',
    )
  }
}

export async function resolveUserSession(
  token: string,
  client?: SessionClient | null,
  options?: { readonly keepDisabledSession?: boolean },
): Promise<AuthUserView | null> {
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const now = Date.now()
  const [row] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      nickname: schema.users.nickname,
      bio: schema.users.bio,
      avatar_key: schema.users.avatar_key,
      updated_at: schema.users.updated_at,
      status: schema.users.status,
      expires_at: schema.user_sessions.expires_at,
      last_active_at: schema.user_sessions.last_active_at,
      family_id: schema.user_sessions.family_id,
    })
    .from(schema.user_sessions)
    .innerJoin(schema.users, eq(schema.user_sessions.user_id, schema.users.id))
    .where(eq(schema.user_sessions.token_hash, tokenHash))
    .limit(1)

  // 随机伪造 token 只走只读查询，避免攻击者用无效 Cookie 制造写锁。
  if (!row) return null
  if (row.status === 'active' && row.expires_at > now) {
    const stale =
      row.last_active_at === null || now - row.last_active_at >= SESSION_ACTIVITY_TOUCH_MS
    if (stale) {
      await db
        .update(schema.user_sessions)
        .set({
          last_active_at: now,
          ...(client?.userAgent ? { user_agent: client.userAgent } : {}),
          ...(client?.ip ? { ip: client.ip } : {}),
        })
        .where(eq(schema.user_sessions.token_hash, tokenHash))
    }
    return accountProfileView(row)
  }

  // 禁用但未过期：普通请求先收回阶段授权再删会话。pending 不在 30 分钟扫描里，
  // 这里不收回的话，随后登出已经查不到主人。收回失败只记日志，会话照样删，避免旧 cookie 在账号恢复后复活。
  // 登出路径保留这一行。derive 若先删掉，处理函数就不知道该收回谁。
  if (row.status !== 'active' && row.expires_at > now) {
    if (!options?.keepDisabledSession) {
      try {
        await endStageAuthorizationsForUser(row.id)
      } catch (error) {
        log.warn(
          { err: error, event: 'auth.session.disabled_reclaim_failed' },
          'stage authorization reclaim failed while dropping a disabled session',
        )
      }
      await dropAccessSession(tokenHash, row.family_id, 'account_disabled')
    }
    return null
  }

  // 仅真实存在但已过期的 access 才清理。链留着，refresh 仍可换一枚新的 access。
  // 过期会话不再收回授权，交给 30 分钟过期扫描。
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
  return null
}

export async function listAccountSessions(
  userId: string,
  currentToken: string,
): Promise<AccountSessionView[]> {
  const currentHash = currentToken ? hashSessionToken(currentToken) : ''
  const now = Date.now()
  const [current] = currentHash
    ? await db
        .select({ family_id: schema.user_sessions.family_id })
        .from(schema.user_sessions)
        .where(eq(schema.user_sessions.token_hash, currentHash))
        .limit(1)
    : []
  const families = await db
    .select({
      id: schema.user_session_families.id,
      user_agent: schema.user_session_families.user_agent,
      ip: schema.user_session_families.ip,
      created_at: schema.user_session_families.created_at,
      refreshed_at: schema.user_session_families.refreshed_at,
    })
    .from(schema.user_session_families)
    .where(
      and(
        eq(schema.user_session_families.user_id, userId),
        isNull(schema.user_session_families.revoked_at),
        gt(schema.user_session_families.refresh_expires_at, now),
        gt(schema.user_session_families.absolute_expires_at, now),
      ),
    )
  const access = await db
    .select({
      token_hash: schema.user_sessions.token_hash,
      family_id: schema.user_sessions.family_id,
      user_agent: schema.user_sessions.user_agent,
      ip: schema.user_sessions.ip,
      created_at: schema.user_sessions.created_at,
      last_active_at: schema.user_sessions.last_active_at,
    })
    .from(schema.user_sessions)
    .where(and(eq(schema.user_sessions.user_id, userId), gt(schema.user_sessions.expires_at, now)))
  const accessByFamily = new Map(
    access.flatMap((row) => (row.family_id ? [[row.family_id, row] as const] : [])),
  )
  const familyRows = families.map((family) => {
    const row = accessByFamily.get(family.id)
    const userAgent = row?.user_agent ?? family.user_agent
    return {
      current: family.id === current?.family_id,
      user_agent: userAgent,
      device_label: deviceLabel(userAgent),
      ip: row?.ip ?? family.ip,
      created_at: family.created_at,
      last_active_at: row?.last_active_at ?? family.refreshed_at,
    }
  })
  const legacyRows = access
    .filter((row) => row.family_id === null)
    .map((row) => ({
      current: row.token_hash === currentHash,
      user_agent: row.user_agent,
      device_label: deviceLabel(row.user_agent),
      ip: row.ip,
      created_at: row.created_at,
      last_active_at: row.last_active_at ?? row.created_at,
    }))
  return [...familyRows, ...legacyRows].sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      right.last_active_at - left.last_active_at ||
      right.created_at - left.created_at,
  )
}

/** 留下当前这枚会话，其余全部作废。对应的 refresh 链一起作废，不能再换出 access。 */
export async function revokeOtherSessions(userId: string, currentToken: string): Promise<number> {
  if (!currentToken) return 0
  const currentHash = hashSessionToken(currentToken)
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ family_id: schema.user_sessions.family_id })
      .from(schema.user_sessions)
      .where(eq(schema.user_sessions.token_hash, currentHash))
      .limit(1)
    await revokeFamilies(tx, userId, 'revoke_others', current?.family_id ?? null)
    const revoked = await tx
      .delete(schema.user_sessions)
      .where(
        and(
          eq(schema.user_sessions.user_id, userId),
          ne(schema.user_sessions.token_hash, currentHash),
        ),
      )
      .returning({ token_hash: schema.user_sessions.token_hash })
    await tx.insert(schema.operator_audits).values({
      id: randomUUID(),
      operator_id: userId,
      action: 'user.sessions.revoke-others',
      target_type: 'user',
      target_id: userId,
      details: { sessions_revoked: revoked.length },
      created_at: Date.now(),
    })
    return revoked.length
  })
}

/**
 * 登出同时认 access 和 refresh。access 过期被清掉之后，浏览器可能只还带着 refresh，
 * 或者登出请求里的 access 哈希已经在并发刷新里换掉。两种都要作废对应的链。
 */
export async function revokeUserSession(accessToken: string, refreshToken = ''): Promise<void> {
  if (!accessToken && !refreshToken) return
  await db.transaction(async (tx) => {
    const familyIds = new Set<string>()
    if (accessToken) {
      const accessHash = hashSessionToken(accessToken)
      const [row] = await tx
        .select({ family_id: schema.user_sessions.family_id })
        .from(schema.user_sessions)
        .where(eq(schema.user_sessions.token_hash, accessHash))
        .limit(1)
      if (row?.family_id) familyIds.add(row.family_id)
      else if (row) {
        await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, accessHash))
      }
      const [retiredAccess] = await tx
        .select({ family_id: schema.user_retired_refresh_tokens.family_id })
        .from(schema.user_retired_refresh_tokens)
        .where(eq(schema.user_retired_refresh_tokens.token_hash, accessHash))
        .limit(1)
      if (retiredAccess) familyIds.add(retiredAccess.family_id)
    }
    if (refreshToken) {
      const refreshHash = hashSessionToken(refreshToken)
      const [current] = await tx
        .select({ id: schema.user_session_families.id })
        .from(schema.user_session_families)
        .where(eq(schema.user_session_families.refresh_token_hash, refreshHash))
        .limit(1)
      if (current) familyIds.add(current.id)
      const [retired] = await tx
        .select({ family_id: schema.user_retired_refresh_tokens.family_id })
        .from(schema.user_retired_refresh_tokens)
        .where(eq(schema.user_retired_refresh_tokens.token_hash, refreshHash))
        .limit(1)
      if (retired) familyIds.add(retired.family_id)
    }
    for (const familyId of familyIds) {
      await revokeFamilies(tx, null, 'logout', null, familyId)
      await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, familyId))
    }
  })
}

/** access 行已经不在时，仍能从 refresh（含已轮换的）找到会话主人，用来收回阶段授权。 */
export async function resolveRefreshSessionUserId(refreshToken: string): Promise<string | null> {
  if (!refreshToken) return null
  const refreshHash = hashSessionToken(refreshToken)
  const [current] = await db
    .select({ user_id: schema.user_session_families.user_id })
    .from(schema.user_session_families)
    .where(eq(schema.user_session_families.refresh_token_hash, refreshHash))
    .limit(1)
  if (current) return current.user_id
  const [retired] = await db
    .select({ user_id: schema.user_session_families.user_id })
    .from(schema.user_retired_refresh_tokens)
    .innerJoin(
      schema.user_session_families,
      eq(schema.user_session_families.id, schema.user_retired_refresh_tokens.family_id),
    )
    .where(eq(schema.user_retired_refresh_tokens.token_hash, refreshHash))
    .limit(1)
  return retired?.user_id ?? null
}

/** 管理员重置密码、禁用账号、吊销全部会话：这个用户的 refresh 全部立刻失效。 */
export async function revokeAllWebSessions(
  tx: SessionTransaction,
  userId: string,
  reason: string,
): Promise<number> {
  await revokeFamilies(tx, userId, reason, null)
  const revoked = await tx
    .delete(schema.user_sessions)
    .where(eq(schema.user_sessions.user_id, userId))
    .returning({ token_hash: schema.user_sessions.token_hash })
  return revoked.length
}

/**
 * 改密码留下当前 access，轮换它的 refresh，其他链全部作废。
 * 旧会话还没有链时，就地挂上一条，不换掉浏览器里的 access cookie。
 */
export async function retainWebSessionAfterPasswordChange(
  tx: SessionTransaction,
  userId: string,
  keepToken: string,
): Promise<{ issued: IssuedWebSession | null; revoked: number }> {
  const now = Date.now()
  const keepHash = keepToken ? hashSessionToken(keepToken) : ''
  const [current] = keepHash
    ? await tx
        .select()
        .from(schema.user_sessions)
        .where(eq(schema.user_sessions.token_hash, keepHash))
        .for('update')
        .limit(1)
    : []
  await revokeFamilies(tx, userId, 'password_change', current?.family_id ?? null)
  const removed = await tx
    .delete(schema.user_sessions)
    .where(
      and(
        eq(schema.user_sessions.user_id, userId),
        ...(keepHash ? [ne(schema.user_sessions.token_hash, keepHash)] : []),
      ),
    )
    .returning({ token_hash: schema.user_sessions.token_hash })
  const revoked = removed.length
  if (!current || current.user_id !== userId || current.expires_at <= now) {
    return { issued: null, revoked }
  }
  if (!current.family_id) {
    const absoluteExpiresAt = current.created_at + USER_SESSION_ABSOLUTE_TTL_MS
    if (absoluteExpiresAt <= now) return { issued: null, revoked }
    const refreshToken = newToken()
    const refreshExpiresAt = cappedExpiry(now, USER_REFRESH_TTL_MS, absoluteExpiresAt)
    const familyId = randomUUID()
    await tx.insert(schema.user_session_families).values({
      id: familyId,
      user_id: userId,
      refresh_token_hash: hashSessionToken(refreshToken),
      created_at: current.created_at,
      refreshed_at: now,
      refresh_expires_at: refreshExpiresAt,
      absolute_expires_at: absoluteExpiresAt,
      revoked_at: null,
      revoke_reason: null,
      user_agent: current.user_agent,
      ip: current.ip,
    })
    await tx
      .update(schema.user_sessions)
      .set({ family_id: familyId })
      .where(eq(schema.user_sessions.token_hash, keepHash))
    return {
      issued: {
        accessToken: keepToken,
        refreshToken,
        accessExpiresAt: current.expires_at,
        refreshExpiresAt,
      },
      revoked,
    }
  }
  const [family] = await tx
    .select()
    .from(schema.user_session_families)
    .where(eq(schema.user_session_families.id, current.family_id))
    .for('update')
    .limit(1)
  if (!family || family.revoked_at !== null || family.absolute_expires_at <= now) {
    return { issued: null, revoked }
  }
  const refreshToken = newToken()
  const refreshExpiresAt = cappedExpiry(now, USER_REFRESH_TTL_MS, family.absolute_expires_at)
  await tx.insert(schema.user_retired_refresh_tokens).values({
    token_hash: family.refresh_token_hash,
    family_id: family.id,
    retired_at: now,
  })
  await tx
    .update(schema.user_session_families)
    .set({
      refresh_token_hash: hashSessionToken(refreshToken),
      refreshed_at: now,
      refresh_expires_at: refreshExpiresAt,
    })
    .where(eq(schema.user_session_families.id, family.id))
  return {
    issued: {
      accessToken: keepToken,
      refreshToken,
      accessExpiresAt: current.expires_at,
      refreshExpiresAt,
    },
    revoked,
  }
}

export type WebSessionRefreshResult =
  | ({ readonly ok: true } & IssuedWebSession)
  | { readonly ok: false; readonly error: 'unauthorized' | 'refresh_raced' | 'refresh_request_completed' }

/**
 * 用 refresh cookie 轮换一对令牌。没有 refresh、但旧 access 仍有效时，升级成一条新链。
 * 同一次请求可重发原结果；无法证明的旧令牌仅拒绝，不能据此吊销正常会话。
 */
export async function refreshWebSessionToken(
  refreshToken: string,
  accessToken: string,
  client?: SessionClient | null,
  requestKey: SessionRefreshRequestKey | null = null,
): Promise<WebSessionRefreshResult> {
  const now = Date.now()
  const outcome = await db.transaction(async (tx) => {
    if (!refreshToken) return upgradeLegacySession(tx, accessToken, client ?? null, now, requestKey)
    const rotated = await rotatePresentedRefresh(tx, refreshToken, client ?? null, now, requestKey)
    if (rotated.kind !== 'missing') return rotated
    return {
      kind: 'done' as const,
      result: { ok: false as const, error: 'unauthorized' as const },
    }
  })
  if (outcome.kind === 'done') return outcome.result
  return { ok: false, error: 'unauthorized' }
}

export async function readAccessExpiry(token: string): Promise<number | null> {
  if (!token) return null
  const [row] = await db
    .select({ expires_at: schema.user_sessions.expires_at })
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
    .limit(1)
  return row?.expires_at ?? null
}

async function dropAccessSession(
  tokenHash: string,
  familyId: string | null,
  reason: string,
): Promise<void> {
  if (familyId) {
    await db.transaction(async (tx) => {
      await revokeFamilies(tx, null, reason, null, familyId)
      await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, familyId))
    })
    return
  }
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
}

async function revokeFamilies(
  tx: SessionTransaction,
  userId: string | null,
  reason: string,
  exceptFamilyId: string | null,
  onlyFamilyId?: string,
): Promise<void> {
  const now = Date.now()
  await tx
    .update(schema.user_session_families)
    .set({ revoked_at: now, revoke_reason: reason })
    .where(
      and(
        userId ? eq(schema.user_session_families.user_id, userId) : undefined,
        onlyFamilyId ? eq(schema.user_session_families.id, onlyFamilyId) : undefined,
        exceptFamilyId ? ne(schema.user_session_families.id, exceptFamilyId) : undefined,
        isNull(schema.user_session_families.revoked_at),
      ),
    )
}

interface FamilyInsert {
  readonly userId: string
  readonly createdAt: number
  readonly absoluteExpiresAt: number
  readonly now: number
  readonly client?: SessionClient | null
  readonly retiringHash: string | null
  readonly rotation?: { token: string; key: SessionRefreshRequestKey }
}

async function insertFamily(
  tx: SessionTransaction,
  input: FamilyInsert,
): Promise<IssuedWebSession> {
  const familyId = randomUUID()
  const refreshToken = input.rotation
    ? successorRefresh(input.rotation.token, input.rotation.key, familyId)
    : newToken()
  const accessToken = input.rotation ? successorAccess(refreshToken, familyId) : newToken()
  const accessExpiresAt = cappedExpiry(input.now, USER_ACCESS_TTL_MS, input.absoluteExpiresAt)
  const refreshExpiresAt = cappedExpiry(input.now, USER_REFRESH_TTL_MS, input.absoluteExpiresAt)
  await tx.insert(schema.user_session_families).values({
    id: familyId,
    user_id: input.userId,
    refresh_token_hash: hashSessionToken(refreshToken),
    created_at: input.createdAt,
    refreshed_at: input.now,
    refresh_expires_at: refreshExpiresAt,
    absolute_expires_at: input.absoluteExpiresAt,
    revoked_at: null,
    revoke_reason: null,
    user_agent: input.client?.userAgent ?? null,
    ip: input.client?.ip ?? null,
  })
  if (input.retiringHash) {
    await tx.insert(schema.user_retired_refresh_tokens).values({
      token_hash: input.retiringHash,
      request_key_hash: input.rotation ? requestMarker(input.rotation.key) : null,
      family_id: familyId,
      retired_at: input.now,
    })
  }
  await tx.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(accessToken),
    user_id: input.userId,
    family_id: familyId,
    created_at: input.now,
    expires_at: accessExpiresAt,
    user_agent: input.client?.userAgent ?? null,
    ip: input.client?.ip ?? null,
    last_active_at: input.now,
  })
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

type RotateOutcome =
  | { readonly kind: 'done'; readonly result: WebSessionRefreshResult }
  | { readonly kind: 'missing' }

function requestMarker(key: SessionRefreshRequestKey): string {
  return hashSessionToken(key)
}

function successorRefresh(token: string, key: SessionRefreshRequestKey, familyId: string): string {
  const secret = createHmac('sha256', token)
    .update(JSON.stringify(['web-session-refresh-v1', familyId, key]))
    .digest('base64url')
  return `r1.${requestMarker(key)}.${secret}`
}

function successorAccess(refresh: string, familyId: string): string {
  return createHmac('sha256', refresh)
    .update(JSON.stringify(['web-session-access-v1', familyId]))
    .digest('base64url')
}

function replayPair(
  family: typeof schema.user_session_families.$inferSelect,
  refreshToken: string,
): IssuedWebSession {
  return {
    refreshToken,
    accessToken: successorAccess(refreshToken, family.id),
    accessExpiresAt: cappedExpiry(
      family.refreshed_at,
      USER_ACCESS_TTL_MS,
      family.absolute_expires_at,
    ),
    refreshExpiresAt: family.refresh_expires_at,
  }
}

async function replayRetired(
  tx: SessionTransaction,
  token: string,
  key: SessionRefreshRequestKey | null,
  retired: { retiredAt: number; family: typeof schema.user_session_families.$inferSelect },
  now: number,
): Promise<RotateOutcome> {
  const family = retired.family
  const [user] = await tx
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, family.user_id))
    .limit(1)
  if (user?.status !== 'active' && family.revoked_at === null) {
    await revokeFamilies(tx, family.user_id, 'account_disabled', null, family.id)
    await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, family.id))
  }
  if (
    family.revoked_at !== null ||
    family.refresh_expires_at <= now ||
    family.absolute_expires_at <= now ||
    user?.status !== 'active'
  )
    return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
  if (key) {
    const successor = successorRefresh(token, key, family.id)
    const hash = hashSessionToken(successor)
    if (hash === family.refresh_token_hash)
      return { kind: 'done', result: { ok: true, ...replayPair(family, successor) } }
    const [previous] = await tx
      .select({ familyId: schema.user_retired_refresh_tokens.family_id })
      .from(schema.user_retired_refresh_tokens)
      .where(
        and(
          eq(schema.user_retired_refresh_tokens.token_hash, hash),
          eq(schema.user_retired_refresh_tokens.family_id, family.id),
        ),
      )
      .limit(1)
    if (previous) return { kind: 'done', result: { ok: false, error: 'refresh_raced' } }
  }
  if (now - retired.retiredAt <= REFRESH_REUSE_GRACE_MS)
    return { kind: 'done', result: { ok: false, error: 'refresh_raced' } }
  // A stale bearer is not proof of theft; rejecting it must not revoke another valid client.
  log.warn(
    { event: 'auth.refresh.retired_rejected', familyId: family.id },
    'retired refresh rejected',
  )
  return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
}

async function rotateFamily(
  tx: SessionTransaction,
  family: typeof schema.user_session_families.$inferSelect,
  client: SessionClient | null,
  now: number,
  rotation?: { token: string; key: SessionRefreshRequestKey },
): Promise<IssuedWebSession> {
  const refreshToken = rotation
    ? successorRefresh(rotation.token, rotation.key, family.id)
    : newToken()
  const accessToken = rotation ? successorAccess(refreshToken, family.id) : newToken()
  const accessExpiresAt = cappedExpiry(now, USER_ACCESS_TTL_MS, family.absolute_expires_at)
  const refreshExpiresAt = cappedExpiry(now, USER_REFRESH_TTL_MS, family.absolute_expires_at)
  await tx.insert(schema.user_retired_refresh_tokens).values({
    token_hash: family.refresh_token_hash,
    request_key_hash: rotation ? requestMarker(rotation.key) : null,
    family_id: family.id,
    retired_at: now,
  })
  await tx
    .update(schema.user_session_families)
    .set({
      refresh_token_hash: hashSessionToken(refreshToken),
      refreshed_at: now,
      refresh_expires_at: refreshExpiresAt,
      user_agent: client?.userAgent ?? family.user_agent,
      ip: client?.ip ?? family.ip,
    })
    .where(eq(schema.user_session_families.id, family.id))
  await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, family.id))
  await tx.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(accessToken),
    user_id: family.user_id,
    family_id: family.id,
    created_at: now,
    expires_at: accessExpiresAt,
    user_agent: client?.userAgent ?? family.user_agent,
    ip: client?.ip ?? family.ip,
    last_active_at: now,
  })
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }
}

async function rotatePresentedRefresh(
  tx: SessionTransaction,
  refreshToken: string,
  client: SessionClient | null,
  now: number,
  requestKey: SessionRefreshRequestKey | null,
): Promise<RotateOutcome> {
  const refreshHash = hashSessionToken(refreshToken)
  const [family] = await tx
    .select()
    .from(schema.user_session_families)
    .where(eq(schema.user_session_families.refresh_token_hash, refreshHash))
    .for('update')
    .limit(1)
  if (family) {
    if (
      family.revoked_at !== null ||
      family.refresh_expires_at <= now ||
      family.absolute_expires_at <= now
    ) {
      if (family.revoked_at === null && family.absolute_expires_at <= now) {
        await revokeFamilies(tx, family.user_id, 'absolute_cap', null, family.id)
        await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, family.id))
      }
      return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
    }
    const [user] = await tx
      .select({ status: schema.users.status })
      .from(schema.users)
      .where(eq(schema.users.id, family.user_id))
      .limit(1)
    if (!user || user.status !== 'active') {
      await revokeFamilies(tx, family.user_id, 'account_disabled', null, family.id)
      await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.family_id, family.id))
      return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
    }
    if (requestKey && refreshToken.startsWith(`r1.${requestMarker(requestKey)}.`))
      return { kind: 'done', result: { ok: true, ...replayPair(family, refreshToken) } }
    if (requestKey) {
      const [used] = await tx.select({ hash: schema.user_retired_refresh_tokens.token_hash })
        .from(schema.user_retired_refresh_tokens)
        .where(and(eq(schema.user_retired_refresh_tokens.family_id, family.id),
          eq(schema.user_retired_refresh_tokens.request_key_hash, requestMarker(requestKey))))
        .limit(1)
      if (used) return { kind: 'done', result: { ok: false, error: 'refresh_request_completed' } }
    }
    const issued = await rotateFamily(
      tx,
      family,
      client,
      now,
      requestKey ? { token: refreshToken, key: requestKey } : undefined,
    )
    return { kind: 'done', result: { ok: true, ...issued } }
  }

  const [retired] = await tx
    .select({
      retiredAt: schema.user_retired_refresh_tokens.retired_at,
      family: schema.user_session_families,
    })
    .from(schema.user_retired_refresh_tokens)
    .innerJoin(
      schema.user_session_families,
      eq(schema.user_session_families.id, schema.user_retired_refresh_tokens.family_id),
    )
    .where(eq(schema.user_retired_refresh_tokens.token_hash, refreshHash))
    .for('update')
    .limit(1)
  if (!retired) return { kind: 'missing' }
  return replayRetired(tx, refreshToken, requestKey, retired, now)
}

async function upgradeLegacySession(
  tx: SessionTransaction,
  accessToken: string,
  client: SessionClient | null,
  now: number,
  requestKey: SessionRefreshRequestKey | null,
): Promise<RotateOutcome> {
  if (!accessToken) return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
  const accessHash = hashSessionToken(accessToken)
  const [row] = await tx
    .select()
    .from(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, accessHash))
    .for('update')
    .limit(1)
  if (row?.family_id) return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
  if (!row || row.expires_at <= now) {
    const [retired] = await tx
      .select({
        retiredAt: schema.user_retired_refresh_tokens.retired_at,
        family: schema.user_session_families,
      })
      .from(schema.user_retired_refresh_tokens)
      .innerJoin(
        schema.user_session_families,
        eq(schema.user_session_families.id, schema.user_retired_refresh_tokens.family_id),
      )
      .where(eq(schema.user_retired_refresh_tokens.token_hash, accessHash))
      .for('update')
      .limit(1)
    if (!retired) return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
    return replayRetired(tx, accessToken, requestKey, retired, now)
  }
  const [user] = await tx
    .select({ status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.id, row.user_id))
    .limit(1)
  if (!user || user.status !== 'active') {
    return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
  }
  const absoluteExpiresAt = row.created_at + USER_SESSION_ABSOLUTE_TTL_MS
  if (absoluteExpiresAt <= now) {
    return { kind: 'done', result: { ok: false, error: 'unauthorized' } }
  }
  const issued = await insertFamily(tx, {
    userId: row.user_id,
    createdAt: row.created_at,
    absoluteExpiresAt,
    now,
    client: client ?? { userAgent: row.user_agent, ip: row.ip },
    retiringHash: accessHash,
    rotation: requestKey ? { token: accessToken, key: requestKey } : undefined,
  })
  await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, accessHash))
  return { kind: 'done', result: { ok: true, ...issued } }
}
