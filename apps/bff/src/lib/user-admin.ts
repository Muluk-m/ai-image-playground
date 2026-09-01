import { randomUUID } from 'node:crypto'
import { isValidPassword, isValidUsername, normalizeUsername } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { oauthUsernameCandidates } from './oauth/username'
import { loadPrivateBffOverlay } from './private-overlay'
import { createUserSession } from './user-session'

export type UserOperationErrorCode =
  | 'invalid_username'
  | 'invalid_password'
  | 'username_taken'
  | 'user_not_found'
  | 'invalid_status'
  | 'account_disabled'

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

// Bun's SQL driver reports the PostgreSQL SQLSTATE in `errno`; `code` holds its own transport code.
function isUniqueViolation(error: unknown): boolean {
  const databaseError =
    error !== null && typeof error === 'object' && 'cause' in error ? error.cause : error
  if (databaseError === null || typeof databaseError !== 'object') return false
  const sqlState = 'errno' in databaseError ? databaseError.errno : null
  return String(sqlState) === '23505'
}

const operationalUserColumns = {
  id: schema.users.id,
  username: schema.users.username,
  status: schema.users.status,
  created_at: schema.users.created_at,
  updated_at: schema.users.updated_at,
  last_login_at: schema.users.last_login_at,
}

async function provisionUser(
  usernameInput: string,
  password: string,
  source: 'operator' | 'self-registration',
): Promise<{ user: OperationalUser; sessionToken: string | null }> {
  const username = normalizeUsername(usernameInput)
  if (!isValidUsername(username)) throw new UserOperationError('invalid_username')
  if (!isValidPassword(password)) throw new UserOperationError('invalid_password')
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1)
  if (existing) throw new UserOperationError('username_taken')

  const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
  const now = Date.now()
  const id = randomUUID()
  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.users)
        .values({
          id,
          username,
          password_hash: passwordHash,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .returning(operationalUserColumns)
      if (!created) throw new Error('created user missing')
      await tx.insert(schema.operator_audits).values(
        source === 'operator'
          ? operatorAudit('user.create', id, { username })
          : {
              ...operatorAudit('user.register', id, { username }),
              operator_id: id,
            },
      )
      await taskHooks.onUserCreated({ tx, userId: id })
      const sessionToken = source === 'self-registration' ? await createUserSession(id, tx) : null
      return { user: created, sessionToken }
    })
  } catch (error) {
    if (isUniqueViolation(error)) throw new UserOperationError('username_taken')
    throw error
  }
}

export async function createUser(
  usernameInput: string,
  password: string,
): Promise<OperationalUser> {
  return (await provisionUser(usernameInput, password, 'operator')).user
}

export async function registerUser(
  usernameInput: string,
  password: string,
): Promise<{ user: OperationalUser; sessionToken: string }> {
  const result = await provisionUser(usernameInput, password, 'self-registration')
  if (!result.sessionToken) throw new Error('registered user session missing')
  return { user: result.user, sessionToken: result.sessionToken }
}

/**
 * Never usable with `Bun.password.verify`, so an OAuth-only account cannot be reached
 * through the password login route.
 */
const OAUTH_PASSWORD_SENTINEL = 'oauth-only-account'

export interface OAuthIdentityInput {
  readonly provider: string
  readonly subject: string
  readonly email: string | null
  readonly displayName: string | null
}

export interface OAuthLoginResult {
  readonly user: { id: string; username: string }
  readonly sessionToken: string
}

export type OAuthLoginOutcome = OAuthLoginResult | { readonly registrationClosed: true }

async function loginExistingIdentity(userId: string): Promise<OAuthLoginResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: schema.users.id,
        username: schema.users.username,
        status: schema.users.status,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    if (!current) throw new UserOperationError('user_not_found')
    if (current.status !== 'active') throw new UserOperationError('account_disabled')

    const now = Date.now()
    await tx
      .update(schema.users)
      .set({ last_login_at: now, updated_at: now })
      .where(eq(schema.users.id, current.id))
    return {
      user: { id: current.id, username: current.username },
      sessionToken: await createUserSession(current.id, tx),
    }
  })
}

async function findIdentityUserId(identity: OAuthIdentityInput): Promise<string | null> {
  const [row] = await db
    .select({ user_id: schema.user_identities.user_id })
    .from(schema.user_identities)
    .where(
      and(
        eq(schema.user_identities.provider, identity.provider),
        eq(schema.user_identities.subject, identity.subject),
      ),
    )
    .limit(1)
  return row?.user_id ?? null
}

/** Candidates already claimed are dropped up front so a collision does not abort a transaction. */
async function firstFreeUsernames(candidates: string[]): Promise<string[]> {
  const taken = await db
    .select({ username: schema.users.username })
    .from(schema.users)
    .where(inArray(schema.users.username, candidates))
  const claimed = new Set(taken.map((row) => row.username))
  const free = candidates.filter((candidate) => !claimed.has(candidate))
  return free.length > 0 ? free : candidates.slice(-1)
}

/** Signs in a third-party subject, provisioning an account on first sight. */
export async function loginWithOAuthIdentity(
  identity: OAuthIdentityInput,
  options: { allowRegistration: boolean },
): Promise<OAuthLoginOutcome> {
  const email = identity.email ? normalizeUsername(identity.email) : null
  const existingUserId = await findIdentityUserId(identity)
  if (existingUserId) return loginExistingIdentity(existingUserId)
  if (!options.allowRegistration) return { registrationClosed: true }

  const taskHooks = (await loadPrivateBffOverlay()).taskHooks
  const candidates = await firstFreeUsernames(oauthUsernameCandidates({ ...identity, email }))
  for (const username of candidates) {
    const now = Date.now()
    const userId = randomUUID()
    try {
      return await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.users)
          .values({
            id: userId,
            username,
            password_hash: OAUTH_PASSWORD_SENTINEL,
            status: 'active',
            created_at: now,
            updated_at: now,
            last_login_at: now,
          })
          .returning({ id: schema.users.id, username: schema.users.username })
        if (!created) throw new Error('created user missing')
        await tx.insert(schema.user_identities).values({
          id: randomUUID(),
          user_id: created.id,
          provider: identity.provider,
          subject: identity.subject,
          email,
          display_name: identity.displayName,
          created_at: now,
        })
        await tx.insert(schema.operator_audits).values({
          ...operatorAudit('user.oauth-register', created.id, {
            username,
            provider: identity.provider,
          }),
          operator_id: created.id,
        })
        // Shares the password-signup hook so a paid deployment still grants the signup credits.
        await taskHooks.onUserCreated({ tx, userId: created.id })
        return { user: created, sessionToken: await createUserSession(created.id, tx) }
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      // A concurrent callback for the same subject wins the identity index; join its account.
      const raced = await findIdentityUserId(identity)
      if (raced) return loginExistingIdentity(raced)
    }
  }
  throw new UserOperationError('username_taken')
}

export async function setUserStatus(userId: string, status: string): Promise<OperationalUser> {
  if (status !== 'active' && status !== 'disabled') {
    throw new UserOperationError('invalid_status')
  }

  const changed = await db.transaction(async (tx) => {
    const [user] = await tx
      .update(schema.users)
      .set({ status, updated_at: Date.now() })
      .where(eq(schema.users.id, userId))
      .returning(operationalUserColumns)
    if (!user) return null
    if (status === 'disabled') {
      await tx.delete(schema.user_sessions).where(eq(schema.user_sessions.user_id, userId))
    }
    await tx
      .insert(schema.operator_audits)
      .values(operatorAudit('user.status.update', userId, { status }))
    return user
  })
  if (!changed) throw new UserOperationError('user_not_found')
  return changed
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
