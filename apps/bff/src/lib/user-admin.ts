import { randomUUID } from 'node:crypto'
import { isValidPassword, isValidUsername, normalizeUsername } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { loadPrivateBffOverlay } from './private-overlay'

export type UserOperationErrorCode =
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'user_not_found'
  | 'invalid_status'

export class UserOperationError extends Error {
  constructor(readonly code: UserOperationErrorCode) {
    super(code)
    this.name = 'UserOperationError'
  }
}

interface OperationalUser {
  id: string
  username: string
  status: 'active' | 'disabled'
  created_at: number
  updated_at: number
  last_login_at: number | null
}

function operatorAudit(action: string, targetId: string, details: Record<string, unknown>) {
  return {
    id: randomUUID(),
    operator_id: 'admin',
    action,
    target_type: 'user',
    target_id: targetId,
    details,
    created_at: Date.now(),
  }
}

async function findUser(userId: string): Promise<OperationalUser | null> {
  const [user] = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      status: schema.users.status,
      created_at: schema.users.created_at,
      updated_at: schema.users.updated_at,
      last_login_at: schema.users.last_login_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1)
  return user ?? null
}

export async function createUser(
  usernameInput: string,
  password: string,
): Promise<OperationalUser> {
  const username = normalizeUsername(usernameInput)
  if (!isValidUsername(username)) throw new UserOperationError('invalid_username')
  if (!isValidPassword(password)) throw new UserOperationError('invalid_password')

  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  const now = Date.now()
  const id = randomUUID()
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.users).values({
        id,
        username,
        password_hash: passwordHash,
        status: 'active',
        created_at: now,
        updated_at: now,
      })
      await tx
        .insert(schema.operator_audits)
        .values(operatorAudit('user.create', id, { username }))
      await taskHooks.onUserCreated({ tx, userId: id })
    })
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new UserOperationError('username_taken')
    }
    throw error
  }

  const user = await findUser(id)
  if (!user) throw new Error('created user missing')
  return user
}

export async function setUserStatus(userId: string, status: string): Promise<OperationalUser> {
  if (status !== 'active' && status !== 'disabled') {
    throw new UserOperationError('invalid_status')
  }

  const changed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.users)
      .set({ status, updated_at: Date.now() })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id })
    if (rows.length === 0) return false
    if (status === 'disabled') {
      await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.user_id, userId))
    }
    await tx
      .insert(schema.operator_audits)
      .values(operatorAudit('user.status.update', userId, { status }))
    return true
  })
  if (!changed) throw new UserOperationError('user_not_found')

  const user = await findUser(userId)
  if (!user) throw new UserOperationError('user_not_found')
  return user
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  if (!isValidPassword(password)) throw new UserOperationError('invalid_password')
  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })

  const changed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.users)
      .set({ password_hash: passwordHash, updated_at: Date.now() })
      .where(eq(schema.users.id, userId))
      .returning({ id: schema.users.id })
    if (rows.length === 0) return false
    const revoked = await tx
      .delete(schema.user_sessions)
      .where(eq(schema.user_sessions.user_id, userId))
      .returning({ token_hash: schema.user_sessions.token_hash })
    await tx
      .insert(schema.operator_audits)
      .values(operatorAudit('user.password.reset', userId, { sessions_revoked: revoked.length }))
    return true
  })
  if (!changed) throw new UserOperationError('user_not_found')
}

export async function revokeUserSessions(userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1)
    if (!user) throw new UserOperationError('user_not_found')
    const revoked = await tx
      .delete(schema.user_sessions)
      .where(eq(schema.user_sessions.user_id, userId))
      .returning({ token_hash: schema.user_sessions.token_hash })
    await tx
      .insert(schema.operator_audits)
      .values(operatorAudit('user.sessions.revoke', userId, { sessions_revoked: revoked.length }))
    return revoked.length
  })
}
