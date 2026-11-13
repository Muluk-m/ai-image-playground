import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AlertMessage } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import type { OperatorSettingsResult } from '../../lib/operator-config-overrides'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'

process.env.DATABASE_URL = await resetTestDatabase('bff_operator_config_prerequisites')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = `${import.meta.dir}/../authenticated-operator-config.json`
process.env.RESEND_API_KEY = ''
process.env.EMAIL_FROM = ''
process.env.EMAIL_CODE_SECRET = ''
process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

// Install the environment before importing process-singleton config and DB consumers.
const { close, db, schema } = await import('../../db/client')
const { app } = await import('../../app')
const { config, setEffectiveOperatorConfig } = await import('../../config')
const { loadOperatorConfig } = await import('../../lib/operator-config')
const { refreshOperatorConfig, setOperatorConfigAlertSenderForTesting } = await import(
  '../../lib/operator-config-overrides'
)
const { setRegistrationEmailSenderForTesting } = await import('../../lib/registration-verification')
const baseline = loadOperatorConfig(process.env.OPERATOR_CONFIG_FILE)
const alerts: AlertMessage[] = []
setOperatorConfigAlertSenderForTesting(async (messages) => {
  alerts.push(...messages)
})
const endpoint = 'http://localhost/internal/admin/operator-config'
const validEmail = {
  resendApiKey: 're_test',
  from: 'Muvloom <login@auth.example.com>',
  codeSecret: 'fixture-email-code-secret-at-least-32-characters',
}
const invalidEmailCases = [
  {
    name: 'missing delivery key',
    email: { ...validEmail, resendApiKey: '' },
    error: 'Missing env: RESEND_API_KEY',
  },
  { name: 'missing sender', email: { ...validEmail, from: '' }, error: 'Missing env: EMAIL_FROM' },
  {
    name: 'quoted sender',
    email: { ...validEmail, from: '"Muvloom <login@auth.example.com>"' },
    error: 'EMAIL_FROM must be an email or Name <email@example.com> without quotes',
  },
  {
    name: 'malformed sender',
    email: { ...validEmail, from: 'not-an-email' },
    error: 'EMAIL_FROM must be an email or Name <email@example.com> without quotes',
  },
  {
    name: 'missing code secret',
    email: { ...validEmail, codeSecret: '' },
    error: 'EMAIL_CODE_SECRET must be at least 32 characters',
  },
  {
    name: 'short code secret',
    email: { ...validEmail, codeSecret: 'too-short' },
    error: 'EMAIL_CODE_SECRET must be at least 32 characters',
  },
]

async function request(path = '', init: RequestInit = {}) {
  return app.handle(
    new Request(`${endpoint}${path}`, {
      ...init,
      headers: {
        authorization: 'Bearer fixture-service-credential-alpha',
        'content-type': 'application/json',
      },
    }),
  )
}

async function save() {
  return request('/accounts%3Aemail-verification', {
    method: 'PUT',
    body: JSON.stringify({ value: true, reason: 'enable verification', expectedRevision: 0 }),
  })
}

async function insertOverride(
  key: string,
  value: boolean | number,
  revision: number,
  baselineValue: boolean | number,
) {
  await db.insert(schema.operator_config_overrides).values({
    key,
    value,
    revision,
    baseline_value: baselineValue,
    operator_id: 'database-repair',
    reason: 'fixture',
    updated_at: Date.now(),
  })
  await db
    .update(schema.operator_config_state)
    .set({ revision })
    .where(eq(schema.operator_config_state.id, 1))
}

afterAll(close)
beforeEach(async () => {
  await db.delete(schema.operator_config_overrides)
  await db.delete(schema.operator_audits)
  await db.delete(schema.email_verification_codes)
  await db
    .update(schema.operator_config_state)
    .set({ revision: 0 })
    .where(eq(schema.operator_config_state.id, 1))
  config.operator = baseline
  Object.assign(config.email, { resendApiKey: '', from: '', codeSecret: '' })
  await refreshOperatorConfig()
  alerts.length = 0
})

describe('operator email verification runtime prerequisites', () => {
  for (const { name, email, error } of invalidEmailCases) {
    it(`rejects a hot write with ${name} without publishing, persisting, or auditing it`, async () => {
      Object.assign(config.email, email)
      expect(() => config.assertValid()).not.toThrow()
      const response = await save()
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: 'dependency_or_derived_rejected',
        details: { rule: error, message: error },
      })
      expect(config.operator.capabilities['accounts:email-verification']).toBe(false)
      const settings = (await (await request()).json()) as OperatorSettingsResult
      expect(settings.revision).toBe(0)
      expect(
        settings.settings.find((row) => row.key === 'accounts:email-verification'),
      ).toMatchObject({ baseline: false, effective: false })
      expect(await db.select().from(schema.operator_config_overrides)).toHaveLength(0)
      expect(await db.select().from(schema.operator_audits)).toHaveLength(0)
      expect(alerts).toHaveLength(0)
    })

    it(`falls back and alerts for a stored override with ${name}, retaining unrelated overrides`, async () => {
      Object.assign(config.email, email)
      await insertOverride('accounts:email-verification', true, 1, false)
      await insertOverride('generation:daily-images', 7, 2, 0)
      const response = await request('/refresh', { method: 'POST' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ revision: 2 })
      expect(config.operator.capabilities['accounts:email-verification']).toBe(false)
      expect(config.operator.quotas['generation:daily-images']).toBe(7)
      const settings = (await (await request()).json()) as OperatorSettingsResult
      expect(
        settings.settings.find((row) => row.key === 'accounts:email-verification'),
      ).toMatchObject({
        baseline: false,
        override: true,
        effective: false,
        invalid: true,
        invalidReason: 'invalid_combination',
      })
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({
        rule: 'operator-config',
        kind: 'firing',
        detail: { key: 'accounts:email-verification', reason: 'invalid_combination' },
      })
    })

    it(`preserves startup errors and the previous snapshot with ${name}`, () => {
      Object.assign(config.email, email)
      const enabled = {
        ...baseline,
        capabilities: { ...baseline.capabilities, 'accounts:email-verification': true },
      }
      const previous = config.operator
      expect(() => setEffectiveOperatorConfig(enabled)).toThrow(error)
      expect(config.operator).toBe(previous)
      config.operator = enabled
      expect(() => config.assertValid()).toThrow(error)
    })
  }

  it('retains fatal baseline validation instead of treating it as an invalid override', async () => {
    config.operator = {
      ...baseline,
      capabilities: { ...baseline.capabilities, 'accounts:email-verification': true },
    }
    expect(() => config.assertValid()).toThrow('Missing env: RESEND_API_KEY')
    await expect(refreshOperatorConfig()).rejects.toThrow('Missing env: RESEND_API_KEY')
    expect(alerts).toHaveLength(0)
  })

  it('enables working registration verification when the runtime prerequisites are configured', async () => {
    Object.assign(config.email, validEmail)
    const response = await save()
    expect(response.status).toBe(200)
    expect(config.operator.capabilities['accounts:email-verification']).toBe(true)
    expect(() => config.assertValid()).not.toThrow()
    let recipient: string | undefined
    setRegistrationEmailSenderForTesting(async (message) => {
      recipient = message.to
    })
    const verification = await app.handle(
      new Request('http://localhost/api/auth/register/verification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'operator-prerequisites@example.com' }),
      }),
    )
    expect(verification.status).toBe(200)
    expect(recipient).toBe('operator-prerequisites@example.com')
    expect(alerts).toHaveLength(0)
  })
})
