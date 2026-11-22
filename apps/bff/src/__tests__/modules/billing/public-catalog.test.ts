import { afterAll, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { and, eq } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('billing_public_catalog')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-public-catalog'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { _setPrivateBffOverlayForTesting } = await import('../../../lib/private-overlay')
_setPrivateBffOverlayForTesting()
const { app } = await import('../../../app')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { billingSettings, modelPrices, planPrices, plans } = await import(
  '@image-playground/db/billing'
)

interface PublicPrice {
  period_months: number
  original_price_cents: number
  effective_price_cents: number
}

interface PublicCatalogJson {
  plans?: Array<{
    id: string
    name: string
    monthly_credits: number
    prices: PublicPrice[]
  }>
  recharge?: { credits_per_yuan: number; amounts_yuan: number[] }
  image_anchor?: { model: string; credits_per_image: number } | null
  referral?: {
    inviter_registration_credits: number
    invitee_registration_credits: number
    paid_reward_basis_points: number
    credits_per_yuan: number
  }
  settings?: unknown
  error?: string
}

async function jsonReq(path: string): Promise<{
  status: number
  json: PublicCatalogJson
  cacheControl: string | null
  raw: string
}> {
  const response = await app.handle(new Request(`http://localhost${path}`))
  const raw = await response.text()
  return {
    status: response.status,
    json: JSON.parse(raw) as PublicCatalogJson,
    cacheControl: response.headers.get('cache-control'),
    raw,
  }
}

afterAll(async () => {
  await closeDb()
})

describe('public billing catalog', () => {
  it('returns live plan discounts without payment settings', async () => {
    const endsAt = Date.now() + 60_000
    await db
      .update(billingSettings)
      .set({
        contact_wechat: 'secret-wechat',
        payment_qr_url: 'https://secret.example/pay',
        updated_at: Date.now(),
      })
      .where(eq(billingSettings.id, 'default'))
    await db
      .update(plans)
      .set({ name: '入门改名', updated_at: Date.now() })
      .where(eq(plans.id, 'starter'))
    await db
      .update(modelPrices)
      .set({ credits_per_image: 80, active: true, updated_at: Date.now() })
      .where(eq(modelPrices.model, 'gpt-image-2'))
    await db
      .update(planPrices)
      .set({
        original_price_cents: 4900,
        discount_price_cents: 3900,
        discount_ends_at: endsAt,
        updated_at: Date.now(),
      })
      .where(and(eq(planPrices.plan_id, 'starter'), eq(planPrices.period_months, 1)))

    const hidden = await jsonReq('/api/billing/catalog')
    expect(hidden.status).toBe(401)

    const published = await jsonReq('/api/billing/public-catalog')
    expect(published.status).toBe(200)
    expect(published.cacheControl).toBe('no-store')
    expect(Object.keys(published.json).sort()).toEqual([
      'image_anchor',
      'plans',
      'recharge',
      'referral',
    ])
    expect(published.raw).not.toContain('secret-wechat')
    expect(published.raw).not.toContain('secret.example')
    expect(published.json.settings).toBeUndefined()
    const starter = published.json.plans?.find((plan) => plan.id === 'starter')
    expect(starter).toMatchObject({ name: '入门改名', monthly_credits: 66_000 })
    expect(starter?.prices.find((price) => price.period_months === 1)).toMatchObject({
      original_price_cents: 4900,
      effective_price_cents: 3900,
    })
    expect(published.json.image_anchor).toEqual({ model: 'gpt-image-2', credits_per_image: 80 })
    expect(published.json.recharge).toMatchObject({
      credits_per_yuan: 400,
      amounts_yuan: [10, 50, 100],
    })
    expect(published.json.referral).toMatchObject({
      inviter_registration_credits: 200,
      invitee_registration_credits: 200,
      paid_reward_basis_points: 500,
      credits_per_yuan: 100,
    })

    await db
      .update(planPrices)
      .set({ discount_ends_at: Date.now() - 1, updated_at: Date.now() })
      .where(and(eq(planPrices.plan_id, 'starter'), eq(planPrices.period_months, 1)))
    const expired = await jsonReq('/api/billing/public-catalog')
    expect(
      expired.json.plans
        ?.find((plan) => plan.id === 'starter')
        ?.prices.find((price) => price.period_months === 1)?.effective_price_cents,
    ).toBe(4900)
  })

  it('折算张数优先用默认模型 Image 2.5 Flare 的单价，没有上架时退回 gpt-image-2', async () => {
    await db
      .update(modelPrices)
      .set({ credits_per_image: 80, active: true, updated_at: Date.now() })
      .where(eq(modelPrices.model, 'gpt-image-2'))
    await db.delete(modelPrices).where(eq(modelPrices.model, 'gpt-image-2.5-flare'))
    const fallback = await jsonReq('/api/billing/public-catalog')
    expect(fallback.json.image_anchor).toEqual({ model: 'gpt-image-2', credits_per_image: 80 })

    await db.insert(modelPrices).values({
      model: 'gpt-image-2.5-flare',
      credits_per_image: 60,
      active: true,
      updated_at: Date.now(),
    })
    const flare = await jsonReq('/api/billing/public-catalog')
    expect(flare.json.image_anchor).toEqual({ model: 'gpt-image-2.5-flare', credits_per_image: 60 })

    await db
      .insert(schema.model_availability)
      .values({
        model: 'gpt-image-2.5-flare',
        active: false,
        updated_at: Date.now(),
      })
      .onConflictDoUpdate({ target: schema.model_availability.model, set: { active: false } })
    const inactive = await jsonReq('/api/billing/public-catalog')
    expect(inactive.json.image_anchor?.model).toBe('gpt-image-2')
    await db.delete(modelPrices).where(eq(modelPrices.model, 'gpt-image-2.5-flare'))
  })
})
