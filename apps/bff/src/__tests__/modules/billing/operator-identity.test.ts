import { afterAll, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('billing_operator_identity')
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.INTERNAL_API_TOKEN = 'fixture-operator-service-token'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(process.env.DATABASE_URL)
const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close, db, schema } = await import('../../../db/client')
const { confirmedPayments } = await import('@image-playground/db/billing')
afterAll(close)

function write(path: string, body: unknown, operator?: string, authorized = true) {
  return app.handle(
    new Request(`http://localhost/internal/admin/private/billing${path}`, {
      method: path === '/settings' || path === '/referrals/policy' ? 'PUT' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorized ? { authorization: 'Bearer fixture-operator-service-token' } : {}),
        ...(operator === undefined ? {} : { 'x-admin-operator': operator }),
      },
      body: JSON.stringify(body),
    }),
  )
}
const settings = { contact_wechat: '', payment_qr_url: '', contact_qr_url: '', guidance: 'test' }

describe('internal billing operator attribution', () => {
  it('requires internal authentication and rejects malformed identities without writing', async () => {
    const before = await db.select().from(schema.operator_audits)
    expect((await write('/settings', settings, 'forged@example.com', false)).status).toBe(401)
    expect((await write('/settings', settings, 'x'.repeat(321))).status).toBe(400)
    expect((await write('/settings', settings, ' ')).status).toBe(400)
    expect(await db.select().from(schema.operator_audits)).toEqual(before)
  })

  it('uses the trusted header and preserves legacy attribution when omitted', async () => {
    for (const actor of ['operator@example.com', undefined]) {
      expect((await write('/settings', settings, actor)).status).toBe(200)
    }
    const audits = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.action, 'billing.settings.update'))
    expect(audits.map((row) => row.operator_id).sort()).toEqual(['admin', 'operator@example.com'])
  })

  it('attributes referral policy changes and applies the same trust checks', async () => {
    const policy = {
      inviter_registration_credits: 0,
      invitee_registration_credits: 0,
      paid_reward_basis_points: 0,
      credits_per_yuan: 100,
    }
    expect((await write('/referrals/policy', policy, 'forged@example.com', false)).status).toBe(401)
    expect((await write('/referrals/policy', policy, 'x'.repeat(321))).status).toBe(400)
    expect((await write('/referrals/policy', policy, 'policy@example.com')).status).toBe(200)
    const audits = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.action, 'billing.referral.policy.update'))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.operator_id).toBe('policy@example.com')
  })

  it('records the original confirmer and keeps it on a replay by another operator', async () => {
    const userId = randomUUID()
    await db.insert(schema.users).values({
      id: userId,
      username: `actor-${userId}`,
      password_hash: 'fixture',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    const operationId = randomUUID()
    const body = {
      amount: 100,
      reason: 'identity test',
      payment: { operation_id: operationId, amount_cents: 100 },
    }
    const path = `/users/${userId}/recharge`
    const { adjustRechargeCredits } = await import('../../../modules/billing/ledger')
    await adjustRechargeCredits({
      userId,
      amount: body.amount,
      reason: body.reason,
      payment: body.payment,
      operatorId: 'first@example.com',
    })
    expect((await write(path, body, 'first@example.com')).status).toBe(200)
    expect((await write(path, body, 'second@example.com')).status).toBe(200)
    const [payment] = await db
      .select()
      .from(confirmedPayments)
      .where(eq(confirmedPayments.id, operationId))
    expect(payment?.operator_id).toBe('first@example.com')
    const audits = await db
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.target_id, userId))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.operator_id).toBe('first@example.com')
  })
})
