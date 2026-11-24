import { afterAll, afterEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { creditLedger, modelPrices, taskHolds } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

const databaseUrl = await resetTestDatabase('analysis_token_quotes')
process.env.DATABASE_URL = databaseUrl
process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config-chat.json')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(databaseUrl)
const { config } = await import('../../../config')
const { db, schema } = await import('../../../db/client')
const { close } = await import('../../../db/client')
const { privateTaskHooks } = await import('../../../modules/billing/hooks')
const operator = config.operator
const model = 'analysis-fixture-model'
afterAll(close)
afterEach(() => {
  config.operator = operator
})

it('quotes token rates and exemption as a serializable snapshot without creating a billing hold', async () => {
  await db.insert(modelPrices).values({
    model,
    credits_per_image: 6,
    unit: 'kilo_token',
    output_credits_per_unit: 30,
    output_reserve_tokens: 1500,
    cached_input_price_percent: 10,
    active: true,
    updated_at: Date.now(),
  })
  const quote = () =>
    db.transaction((tx) =>
      privateTaskHooks.quoteTokenTask!({
        tx,
        userId: 'quote-owner',
        model,
        estimatedInputTokens: 10000,
      }),
    )
  const first = await quote()
  expect(first).toMatchObject({
    estimatedCredits: 105,
    pricing: {
      model,
      unit: 'kilo_token',
      quantity: 1,
      unitMultiplier: 17.5,
      baseUnitCredits: 6,
      outputPriceRatio: 5,
      cachedInputPriceRatio: 0.1,
      inputEstimateTokens: 10000,
      outputReserveTokens: 1500,
      exemption: 'none',
    },
  })
  expect(JSON.parse(JSON.stringify(first))).toEqual(first)
  expect(await db.select().from(taskHolds)).toHaveLength(0)
  expect(await db.select().from(creditLedger)).toHaveLength(0)

  config.operator = {
    ...operator,
    capabilities: { ...operator.capabilities, 'billing:chat-free': true },
  }
  const waived = await quote()
  expect(waived).toMatchObject({ estimatedCredits: 105, pricing: { exemption: 'chat-free' } })
  expect(waived?.pricing.pricingVersion).not.toBe(first?.pricing.pricingVersion)
  await db
    .update(modelPrices)
    .set({ output_credits_per_unit: 36 })
    .where(eq(modelPrices.model, model))
  expect((await quote())?.pricing.pricingVersion).not.toBe(waived?.pricing.pricingVersion)
  await db.update(modelPrices).set({ active: false }).where(eq(modelPrices.model, model))
  expect(await quote()).toMatchObject({ estimatedCredits: 114 })
  await db
    .insert(schema.model_availability)
    .values({ model, active: false, updated_at: Date.now() })
  expect(await quote()).toBeNull()
})
