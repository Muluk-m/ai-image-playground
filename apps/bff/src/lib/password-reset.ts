import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, eq, gt, isNotNull, lt } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { revokeAllWebSessions } from './user-session'

const TOKEN_TTL_MS = 30 * 60_000
const RESET_ENDPOINT = 'https://api.resend.com/emails'
type PasswordResetEmailSender = (input: { to: string; url: string }) => Promise<void>

async function sendWithResend({ to, url }: { to: string; url: string }): Promise<void> {
  const response = await fetch(RESET_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.email.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [to],
      subject: '幕芽 Muvloom 重置密码',
      text: `请打开以下链接重置你的幕芽 Muvloom 密码（30 分钟内有效）：\n\n${url}\n\n如果不是你本人操作，请忽略这封邮件。`,
      html: `<p>请在 30 分钟内打开以下链接重置你的幕芽 Muvloom 密码：</p><p><a href="${url}">重置密码</a></p><p>如果不是你本人操作，请忽略这封邮件。</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Resend email request failed with status ${response.status}`)
}

let emailSender: PasswordResetEmailSender = sendWithResend
export function setPasswordResetEmailSenderForTesting(sender?: PasswordResetEmailSender): void {
  emailSender = sender ?? sendWithResend
}

export async function revokePasswordResetTokens(
  tx: Pick<typeof db, 'delete'>,
  userId: string,
): Promise<void> {
  await tx
    .delete(schema.password_reset_tokens)
    .where(eq(schema.password_reset_tokens.user_id, userId))
}
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
function resetUrl(token: string): string {
  const origin = config.auth.frontendOrigin || config.auth.frontendOrigins[0]
  if (!origin) throw new Error('AUTH_FRONTEND_ORIGIN is required for password recovery')
  const url = new URL('/login', origin)
  url.searchParams.set('reset_token', token)
  return url.toString()
}

/** Always returns success to avoid exposing whether an email is registered. */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase()
  const now = Date.now()
  const token = randomBytes(32).toString('base64url')
  const user = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: schema.users.id, email: schema.users.username })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.username, normalized),
          eq(schema.users.status, 'active'),
          isNotNull(schema.users.email_verified_at),
        ),
      )
      .for('update')
      .limit(1)
    if (!row) return null
    await tx
      .delete(schema.password_reset_tokens)
      .where(lt(schema.password_reset_tokens.expires_at, now))
    await revokePasswordResetTokens(tx, row.id)
    await tx.insert(schema.password_reset_tokens).values({
      id: randomUUID(),
      user_id: row.id,
      token_hash: hashToken(token),
      created_at: now,
      expires_at: now + TOKEN_TTL_MS,
    })
    return row
  })
  if (!user) return
  try {
    await emailSender({ to: user.email, url: resetUrl(token) })
  } catch {
    await db
      .delete(schema.password_reset_tokens)
      .where(eq(schema.password_reset_tokens.token_hash, hashToken(token)))
    throw new Error('password_reset_email_failed')
  }
}

export async function resetPassword(token: string, password: string): Promise<void> {
  const tokenHash = hashToken(token)
  const now = Date.now()
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ user_id: schema.password_reset_tokens.user_id })
      .from(schema.password_reset_tokens)
      .where(
        and(
          eq(schema.password_reset_tokens.token_hash, tokenHash),
          gt(schema.password_reset_tokens.expires_at, now),
        ),
      )
      .for('update')
      .limit(1)
    if (!row) throw new Error('invalid_password_reset')
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
    await tx
      .update(schema.users)
      .set({ password_hash: passwordHash, updated_at: now })
      .where(eq(schema.users.id, row.user_id))
    await revokeAllWebSessions(tx, row.user_id, 'password_recovery')
    await tx
      .delete(schema.password_reset_tokens)
      .where(eq(schema.password_reset_tokens.token_hash, tokenHash))
  })
}
