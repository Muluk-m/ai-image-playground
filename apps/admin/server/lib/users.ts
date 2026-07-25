import { randomUUID } from 'node:crypto'
import { createDb, type UserStatus } from '@image-playground/db'
import { isValidPassword, isValidUsername, normalizeUsername } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { config } from '../config'

type Handle = ReturnType<typeof createDb>
const handles = new Map<string, Handle>()

/**
 * 用户管理是 admin 唯一允许写业务库的边界。任务、图片等运营查询仍使用 queries.ts
 * 的 readonly handle，避免扩大后台误写范围。
 */
function getHandle(): Handle {
  const url = process.env.DATABASE_URL?.trim() || config.databaseUrl
  let handle = handles.get(url)
  if (!handle) {
    handle = createDb(url)
    handles.set(url, handle)
  }
  return handle
}

export interface AdminUserRow {
  id: string
  username: string
  status: UserStatus
  created_at: number
  updated_at: number
  last_login_at: number | null
  active_sessions: number
  task_count: number
}

export type UserMutationErrorCode =
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'user_not_found'
  | 'invalid_status'

export class UserMutationError extends Error {
  constructor(readonly code: UserMutationErrorCode) {
    super(code)
    this.name = 'UserMutationError'
  }
}

export async function listUsers(): Promise<AdminUserRow[]> {
  const { db } = getHandle()
  const now = Date.now()
  const rows = (await db.all(sql`
    SELECT
      u.id,
      u.username,
      u.status,
      u.created_at,
      u.updated_at,
      u.last_login_at,
      (
        SELECT COUNT(*)
        FROM user_sessions s
        WHERE s.user_id = u.id AND s.expires_at > ${now}
      ) AS active_sessions,
      (
        SELECT COUNT(*)
        FROM tasks t
        WHERE t.user_id = u.id
      ) AS task_count
    FROM users u
    ORDER BY u.created_at DESC, u.id DESC
  `)) as unknown as Array<Record<string, unknown>>

  return rows.map((row) => ({
    id: String(row.id),
    username: String(row.username),
    status: row.status === 'disabled' ? 'disabled' : 'active',
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    last_login_at: row.last_login_at === null ? null : Number(row.last_login_at),
    active_sessions: Number(row.active_sessions),
    task_count: Number(row.task_count),
  }))
}

export async function createUser(usernameInput: string, password: string): Promise<AdminUserRow> {
  const username = normalizeUsername(usernameInput)
  if (!isValidUsername(username)) throw new UserMutationError('invalid_username')
  if (!isValidPassword(password)) throw new UserMutationError('invalid_password')

  const { db, schema } = getHandle()
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1)
  if (existing.length > 0) throw new UserMutationError('username_taken')

  const now = Date.now()
  const id = randomUUID()
  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  try {
    await db.insert(schema.users).values({
      id,
      username,
      password_hash: passwordHash,
      status: 'active',
      created_at: now,
      updated_at: now,
    })
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed')) {
      throw new UserMutationError('username_taken')
    }
    throw error
  }

  const created = (await listUsers()).find((user) => user.id === id)
  if (!created) throw new Error('created user missing')
  return created
}

export async function setUserStatus(userId: string, status: string): Promise<AdminUserRow> {
  if (status !== 'active' && status !== 'disabled') {
    throw new UserMutationError('invalid_status')
  }

  const { db, schema } = getHandle()
  const now = Date.now()
  const changed = db.transaction((tx) => {
    const rows = tx
      .update(schema.users)
      .set({ status, updated_at: now })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id })
      .all()
    if (rows.length === 0) return false
    if (status === 'disabled') {
      tx.delete(schema.user_sessions).where(eq(schema.user_sessions.user_id, userId)).run()
    }
    return true
  })
  if (!changed) throw new UserMutationError('user_not_found')

  const updated = (await listUsers()).find((user) => user.id === userId)
  if (!updated) throw new UserMutationError('user_not_found')
  return updated
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  if (!isValidPassword(password)) throw new UserMutationError('invalid_password')

  const { db, schema } = getHandle()
  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  const changed = db.transaction((tx) => {
    const rows = tx
      .update(schema.users)
      .set({ password_hash: passwordHash, updated_at: Date.now() })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id })
      .all()
    if (rows.length === 0) return false
    tx.delete(schema.user_sessions).where(eq(schema.user_sessions.user_id, userId)).run()
    return true
  })
  if (!changed) throw new UserMutationError('user_not_found')
}

export async function revokeUserSessions(userId: string): Promise<number> {
  const { db, schema } = getHandle()
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  if (!user) throw new UserMutationError('user_not_found')

  const revoked = await db
    .delete(schema.user_sessions)
    .where(and(eq(schema.user_sessions.user_id, userId)))
    .returning({ token_hash: schema.user_sessions.token_hash })
  return revoked.length
}
