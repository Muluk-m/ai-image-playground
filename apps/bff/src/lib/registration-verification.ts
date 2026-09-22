import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq, lt } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'

const CODE_DIGITS = 6
const CODE_TTL_MS = 10 * 60_000
const RESEND_COOLDOWN_MS = 60_000
const MAX_ATTEMPTS = 5
const EXPIRED_RETENTION_MS = 24 * 60 * 60_000
const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export type RegistrationVerificationErrorCode =
  | 'invalid_email_verification'
  | 'email_verification_expired'

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type RegistrationEmailSender = (input: { to: string; code: string }) => Promise<void>

export class RegistrationVerificationIssueError extends Error {
  constructor(readonly code: 'rate_limited' | 'email_delivery_failed') {
    super(code)
    this.name = 'RegistrationVerificationIssueError'
  }
}

async function sendWithResend({ to, code }: { to: string; code: string }): Promise<void> {
  const response = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.email.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [to],
      subject: `${code} — 幕芽 Muvloom 邮箱验证码`,
      text: `你的幕芽 Muvloom 验证码是 ${code}。验证码将在 10 分钟后失效，请勿转发给他人。\n\nYour Muvloom verification code is ${code}. It expires in 10 minutes. Do not share it with anyone.`,
      html: `<p>你的幕芽 Muvloom 验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:0.2em">${code}</p><p>验证码将在 10 分钟后失效，请勿转发给他人。</p><hr><p>Your Muvloom verification code is <strong>${code}</strong>. It expires in 10 minutes. Do not share it with anyone.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Resend email request failed with status ${response.status}`)
}

let emailSender: RegistrationEmailSender = sendWithResend

export function setRegistrationEmailSenderForTesting(sender?: RegistrationEmailSender): void {
  emailSender = sender ?? sendWithResend
}

function codeHash(challengeId: string, code: string): Buffer {
  return createHmac('sha256', config.email.codeSecret).update(`${challengeId}:${code}`).digest()
}

export async function issueRegistrationVerification(email: string): Promise<{
  challengeId: string
  expiresInSeconds: number
}> {
  const now = Date.now()
  const challengeId = randomUUID()
  const code = randomInt(0, 10 ** CODE_DIGITS)
    .toString()
    .padStart(CODE_DIGITS, '0')
  const issued = await db.transaction(async (tx) => {
    await tx
      .delete(schema.email_verification_codes)
      .where(lt(schema.email_verification_codes.expires_at, now - EXPIRED_RETENTION_MS))
    const [existing] = await tx
      .select({ created_at: schema.email_verification_codes.created_at })
      .from(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.email, email))
      .for('update')
    if (existing && now - existing.created_at < RESEND_COOLDOWN_MS) return false

    const values = {
      id: challengeId,
      email,
      code_hash: codeHash(challengeId, code).toString('hex'),
      attempts: 0,
      created_at: now,
      expires_at: now + CODE_TTL_MS,
    }
    if (existing) {
      await tx
        .update(schema.email_verification_codes)
        .set(values)
        .where(eq(schema.email_verification_codes.email, email))
    } else {
      const [inserted] = await tx
        .insert(schema.email_verification_codes)
        .values(values)
        .onConflictDoNothing({ target: schema.email_verification_codes.email })
        .returning({ id: schema.email_verification_codes.id })
      if (!inserted) return false
    }
    return true
  })

  if (!issued) throw new RegistrationVerificationIssueError('rate_limited')
  try {
    await emailSender({ to: email, code })
  } catch {
    await db
      .delete(schema.email_verification_codes)
      .where(
        and(
          eq(schema.email_verification_codes.id, challengeId),
          eq(schema.email_verification_codes.email, email),
        ),
      )
    throw new RegistrationVerificationIssueError('email_delivery_failed')
  }
  return { challengeId, expiresInSeconds: CODE_TTL_MS / 1000 }
}

export async function consumeRegistrationVerification(
  tx: DbTransaction,
  input: { challengeId: string; email: string; code: string; now: number },
): Promise<RegistrationVerificationErrorCode | null> {
  const [verification] = await tx
    .select({
      code_hash: schema.email_verification_codes.code_hash,
      attempts: schema.email_verification_codes.attempts,
      expires_at: schema.email_verification_codes.expires_at,
    })
    .from(schema.email_verification_codes)
    .where(
      and(
        eq(schema.email_verification_codes.id, input.challengeId),
        eq(schema.email_verification_codes.email, input.email),
      ),
    )
    .for('update')

  if (!verification) return 'invalid_email_verification'
  if (verification.expires_at <= input.now) {
    await tx
      .delete(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.id, input.challengeId))
    return 'email_verification_expired'
  }

  const expected = Buffer.from(verification.code_hash, 'hex')
  const supplied = codeHash(input.challengeId, input.code)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    if (verification.attempts + 1 >= MAX_ATTEMPTS) {
      await tx
        .delete(schema.email_verification_codes)
        .where(eq(schema.email_verification_codes.id, input.challengeId))
    } else {
      await tx
        .update(schema.email_verification_codes)
        .set({ attempts: verification.attempts + 1 })
        .where(eq(schema.email_verification_codes.id, input.challengeId))
    }
    return 'invalid_email_verification'
  }

  await tx
    .delete(schema.email_verification_codes)
    .where(eq(schema.email_verification_codes.id, input.challengeId))
  return null
}
