import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('bff_email_verification')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../authenticated-email-verification-operator-config.json',
)
process.env.RESEND_API_KEY = 're_test'
process.env.EMAIL_FROM = 'Muvloom <login@auth.example.com>'
process.env.EMAIL_CODE_SECRET = 'fixture-email-code-secret-at-least-32-characters'

// The app and DB are module singletons, so test env must be installed before these imports.
const { config } = await import('../../config')
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setRegistrationEmailSenderForTesting } = await import('../../lib/registration-verification')

beforeAll(async () => {
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  await db.delete(schema.email_verification_codes)
})

afterAll(async () => {
  await closeDb()
})

process.on('exit', () => {
  void closeDb()
})

function request(path: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function issueCode(email: string): Promise<{ challengeId: string; code: string }> {
  let delivered: { to: string; code: string } | undefined
  setRegistrationEmailSenderForTesting(async (message) => {
    delivered = message
  })
  const response = await request('/api/auth/register/verification', { email })
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    challenge_id: string
    expires_in_seconds: number
  }
  expect(body.expires_in_seconds).toBe(600)
  expect(delivered?.to).toBe(email)
  expect(delivered?.code).toMatch(/^\d{6}$/)
  return { challengeId: body.challenge_id, code: delivered!.code }
}

describe('registration email verification', () => {
  it('refuses to start without email delivery credentials', () => {
    const apiKey = config.email.resendApiKey
    try {
      config.email.resendApiKey = ''
      expect(() => config.assertValid()).toThrow('Missing env: RESEND_API_KEY')
    } finally {
      config.email.resendApiKey = apiKey
    }
  })
  it('rejects quoted sender values copied into Docker env files', () => {
    const from = config.email.from
    try {
      config.email.from = '"Muvloom <login@auth.example.com>"'
      expect(() => config.assertValid()).toThrow('EMAIL_FROM must be an email')
    } finally {
      config.email.from = from
    }
  })

  it('requires a delivered code, counts failures, and consumes it with the account creation', async () => {
    const email = 'verified@example.com'
    const { challengeId, code } = await issueCode(email)

    const missing = await request('/api/auth/register', {
      username: email,
      password: 'correct horse battery staple',
    })
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: 'email_verification_required' })

    const invalid = await request('/api/auth/register', {
      username: email,
      password: 'correct horse battery staple',
      verification_id: challengeId,
      verification_code: code === '000000' ? '111111' : '000000',
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid_email_verification' })
    const [failedAttempt] = await db
      .select({ attempts: schema.email_verification_codes.attempts })
      .from(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.id, challengeId))
    expect(failedAttempt?.attempts).toBe(1)

    const created = await request('/api/auth/register', {
      username: email,
      password: 'correct horse battery staple',
      verification_id: challengeId,
      verification_code: code,
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('set-cookie')).toContain('image_playground_session=')
    const [user] = await db
      .select({ emailVerifiedAt: schema.users.email_verified_at })
      .from(schema.users)
      .where(eq(schema.users.username, email))
    expect(user?.emailVerifiedAt).toBeNumber()
    const remaining = await db
      .select({ id: schema.email_verification_codes.id })
      .from(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.id, challengeId))
    expect(remaining).toEqual([])
  })

  it('rejects an expired code and removes it', async () => {
    const email = 'expired@example.com'
    const { challengeId, code } = await issueCode(email)
    await db
      .update(schema.email_verification_codes)
      .set({ expires_at: Date.now() - 1 })
      .where(eq(schema.email_verification_codes.id, challengeId))

    const response = await request('/api/auth/register', {
      username: email,
      password: 'correct horse battery staple',
      verification_id: challengeId,
      verification_code: code,
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'email_verification_expired' })
    const remaining = await db
      .select({ id: schema.email_verification_codes.id })
      .from(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.id, challengeId))
    expect(remaining).toEqual([])
  })

  it('does not leave an active challenge when delivery fails', async () => {
    setRegistrationEmailSenderForTesting(async () => {
      throw new Error('provider unavailable')
    })
    const response = await request('/api/auth/register/verification', {
      email: 'delivery-failed@example.com',
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'email_delivery_failed' })
    const remaining = await db
      .select({ id: schema.email_verification_codes.id })
      .from(schema.email_verification_codes)
      .where(eq(schema.email_verification_codes.email, 'delivery-failed@example.com'))
    expect(remaining).toEqual([])
  })
})
