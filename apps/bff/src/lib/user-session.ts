import { createHash, randomBytes } from 'node:crypto'
import type { AuthUserView } from '@image-playground/shared'
import { and, eq, gt, lte } from 'drizzle-orm'
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
    })
    .from(schema.user_sessions)
    .innerJoin(schema.users, eq(schema.user_sessions.user_id, schema.users.id))
    .where(
      and(
        eq(schema.user_sessions.token_hash, tokenHash),
        gt(schema.user_sessions.expires_at, now),
        eq(schema.users.status, 'active'),
      ),
    )
    .limit(1)

  if (row) return row

  // 过期 session 或已禁用账号的 token 都立即失效。按 hash 定点删除，不做全表扫描。
  await db.delete(schema.user_sessions).where(eq(schema.user_sessions.token_hash, tokenHash))
  return null
}

export async function revokeUserSession(token: string): Promise<void> {
  if (!token) return
  await db
    .delete(schema.user_sessions)
    .where(eq(schema.user_sessions.token_hash, hashSessionToken(token)))
}
