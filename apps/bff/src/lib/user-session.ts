import { createHash, randomBytes } from 'node:crypto'
import type { AuthUserView } from '@image-playground/shared'
import { eq, lte } from 'drizzle-orm'
import { db, schema } from '../db/client'

export const USER_SESSION_COOKIE = 'image_playground_session'
export const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createUserSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  // 成功登录时顺手清理全局过期 session，避免长期不再访问的旧 cookie 留在库里。
  await db.delete(schema.user_sessions).where(lte(schema.user_sessions.expires_at, now))
  await db.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(token),
    user_id: userId,
    created_at: now,
    expires_at: now + USER_SESSION_TTL_MS,
  })
  return token
}

export async function resolveUserSession(token: string): Promise<AuthUserView | null> {
  if (!token) return null
  const tokenHash = hashSessionToken(token)
  const now = Date.now()
  const [row] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      status: schema.users.status,
      expires_at: schema.user_sessions.expires_at,
    })
    .from(schema.user_sessions)
    .innerJoin(schema.users, eq(schema.user_sessions.user_id, schema.users.id))
    .where(eq(schema.user_sessions.token_hash, tokenHash))
    .limit(1)

  // 随机伪造 token 只走只读查询，避免攻击者用无效 Cookie 制造 SQLite 写锁。
  if (!row) return null
  if (row.status === 'active' && row.expires_at > now) {
    return { id: row.id, username: row.username }
  }

  // 仅真实存在但已过期/禁用的 session 才清理。
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
  return null
}

export async function revokeUserSession(token: string): Promise<void> {
  if (!token) return
  await db
    .delete(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
}
