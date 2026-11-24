import { eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { accountProfileView } from './account-profile-view'
import { issueUserSession, type sessionClientFromRequest } from './user-session'

export async function findUserByUsername(username: string) {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .limit(1)
  return user ?? null
}

export async function completePasswordLogin(
  userId: string,
  expectedPasswordHash: string,
  client: ReturnType<typeof sessionClientFromRequest>,
) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        id: schema.users.id,
        password_hash: schema.users.password_hash,
        status: schema.users.status,
        username: schema.users.username,
        nickname: schema.users.nickname,
        bio: schema.users.bio,
        avatar_key: schema.users.avatar_key,
        updated_at: schema.users.updated_at,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for('update')
    if (!current || current.status !== 'active' || current.password_hash !== expectedPasswordHash) {
      return null
    }

    const now = Date.now()
    await tx
      .update(schema.users)
      .set({ last_login_at: now, updated_at: now })
      .where(eq(schema.users.id, current.id))

    const issued = await issueUserSession(current.id, tx, client)
    return { issued, user: accountProfileView({ ...current, updated_at: now }) }
  })
}
