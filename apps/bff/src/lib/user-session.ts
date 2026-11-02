import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  type AccountSessionView,
  type AuthUserView,
  USER_SESSION_COOKIE,
  USER_SESSION_HINT_COOKIE,
} from '@image-playground/shared'
import { and, eq, gt, lte, ne } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { accountProfileView } from './account-profile-view'
import { endStageAuthorizationsForUser } from './agent/stage-authorizations'
import { deviceLabel } from './device-label'
import { clientAddress } from './http'
import { log } from './logger'

type SessionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export { USER_SESSION_COOKIE }
/** 登出路径。会话解析要认出它，避免先删掉禁用账号的会话。 */
export const USER_LOGOUT_PATH = '/api/auth/logout'
export const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
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

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: USER_SESSION_TTL_MS / 1000,
} as const

const HINT_COOKIE_OPTIONS = {
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
  path: '/',
  maxAge: USER_SESSION_TTL_MS / 1000,
} as const

interface MutableCookie {
  set(options: Record<string, unknown> & { value: string }): void
}

/**
 * Every route that signs a user in must issue the identical cookie scope.
 * 会话 cookie 必须先写：调用方用第一条 Set-Cookie 取 token。
 */
export function setUserSessionCookie(jar: Record<string, MutableCookie>, token: string): void {
  jar[USER_SESSION_COOKIE]?.set({ ...SESSION_COOKIE_OPTIONS, value: token })
  jar[USER_SESSION_HINT_COOKIE]?.set({ ...HINT_COOKIE_OPTIONS, value: '1' })
}

export function clearUserSessionCookie(jar: Record<string, MutableCookie>): void {
  jar[USER_SESSION_COOKIE]?.set({ ...SESSION_COOKIE_OPTIONS, value: '', maxAge: 0 })
  jar[USER_SESSION_HINT_COOKIE]?.set({ ...HINT_COOKIE_OPTIONS, value: '', maxAge: 0 })
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createUserSession(
  userId: string,
  tx: SessionTransaction,
  client?: SessionClient | null,
): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  // 成功登录时顺手清理全局过期 session，避免长期不再访问的旧 cookie 留在库里。
  await tx.delete(schema.user_sessions).where(lte(schema.user_sessions.expires_at, now))
  await tx.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(token),
    user_id: userId,
    created_at: now,
    expires_at: now + USER_SESSION_TTL_MS,
    user_agent: client?.userAgent ?? null,
    ip: client?.ip ?? null,
    last_active_at: now,
  })
  return token
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
      await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
    }
    return null
  }

  // 仅真实存在但已过期的 session 才清理。过期会话不再收回授权，交给 30 分钟过期扫描。
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
  return null
}

export async function listAccountSessions(
  userId: string,
  currentToken: string,
): Promise<AccountSessionView[]> {
  const currentHash = currentToken ? hashSessionToken(currentToken) : ''
  const now = Date.now()
  const rows = await db
    .select({
      token_hash: schema.user_sessions.token_hash,
      user_agent: schema.user_sessions.user_agent,
      ip: schema.user_sessions.ip,
      created_at: schema.user_sessions.created_at,
      last_active_at: schema.user_sessions.last_active_at,
    })
    .from(schema.user_sessions)
    .where(and(eq(schema.user_sessions.user_id, userId), gt(schema.user_sessions.expires_at, now)))
  return rows
    .map((row) => ({
      current: row.token_hash === currentHash,
      user_agent: row.user_agent,
      device_label: deviceLabel(row.user_agent),
      ip: row.ip,
      created_at: row.created_at,
      last_active_at: row.last_active_at ?? row.created_at,
    }))
    .sort(
      (left, right) =>
        Number(right.current) - Number(left.current) ||
        right.last_active_at - left.last_active_at ||
        right.created_at - left.created_at,
    )
}

/** 留下当前这枚会话，其余全部作废。 */
export async function revokeOtherSessions(userId: string, currentToken: string): Promise<number> {
  if (!currentToken) return 0
  const currentHash = hashSessionToken(currentToken)
  return db.transaction(async (tx) => {
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

export async function revokeUserSession(token: string): Promise<void> {
  if (!token) return
  await db
    .delete(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
}
