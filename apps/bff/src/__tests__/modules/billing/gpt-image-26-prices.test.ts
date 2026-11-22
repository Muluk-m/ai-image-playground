import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ensureBillingMigrations } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SQL } from 'bun'

const database = await resetTestDatabase('gpt_image_26_prices')
await ensureBillingMigrations(database)
const sql = new SQL(database)
const migration = readFileSync(
  new URL(
    '../../../../../../packages/db/drizzle-billing/0025_gpt_image_26_prices.sql',
    import.meta.url,
  ),
  'utf8',
)
const MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']
afterAll(async () => {
  await sql.close()
})

describe('GPT Image 2.6 price migration', () => {
  it('prices both 2.6 models at the 100-credit base unit', async () => {
    const rows =
      await sql`SELECT model, credits_per_image, unit, active FROM billing_model_prices WHERE model IN ${sql(MODELS)} ORDER BY model`
    expect(rows).toEqual([
      { model: 'gpt-image-2.6-flare', credits_per_image: 100, unit: 'image', active: true },
      { model: 'gpt-image-2.6-sunburst', credits_per_image: 100, unit: 'image', active: true },
    ])
    const unchanged =
      await sql`SELECT model, credits_per_image FROM billing_model_prices WHERE model IN ('gpt-image-2', 'gemini-3-pro-image', 'gemini-3.1-flash-lite-image') ORDER BY model`
    expect(unchanged).toEqual([
      { model: 'gemini-3-pro-image', credits_per_image: 150 },
      { model: 'gemini-3.1-flash-lite-image', credits_per_image: 80 },
      { model: 'gpt-image-2', credits_per_image: 100 },
    ])
  })

  it('keeps a price and switch the operator already changed when it runs again', async () => {
    await sql`UPDATE billing_model_prices SET credits_per_image = 420, active = false WHERE model = 'gpt-image-2.6-flare'`
    await sql.unsafe(migration)
    const [row] =
      await sql`SELECT credits_per_image, active FROM billing_model_prices WHERE model = 'gpt-image-2.6-flare'`
    expect(row).toEqual({ credits_per_image: 420, active: false })
  })
})
