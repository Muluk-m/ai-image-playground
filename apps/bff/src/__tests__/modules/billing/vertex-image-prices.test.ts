import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ensureBillingMigrations } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SQL } from 'bun'

const database = await resetTestDatabase('vertex_image_prices')
await ensureBillingMigrations(database)
const sql = new SQL(database)
const migration = readFileSync(
  new URL('../migrations/0019_vertex_image_prices.sql', import.meta.url),
  'utf8',
)
const MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-lite-image', 'gemini-nano-banana-2.1']
afterAll(async () => {
  await sql.close()
})

describe('Vertex image price migration', () => {
  it('prices the three Vertex image models per image', async () => {
    const rows =
      await sql`SELECT model, credits_per_image, unit, active FROM billing_model_prices WHERE model IN ${sql(MODELS)} ORDER BY model`
    expect(rows).toEqual([
      { model: 'gemini-3-pro-image', credits_per_image: 150, unit: 'image', active: true },
      { model: 'gemini-3.1-flash-lite-image', credits_per_image: 80, unit: 'image', active: true },
      { model: 'gemini-nano-banana-2.1', credits_per_image: 100, unit: 'image', active: true },
    ])
  })

  it('keeps a price and switch the operator already changed when it runs again', async () => {
    await sql`UPDATE billing_model_prices SET credits_per_image = 420, active = false WHERE model = 'gemini-3-pro-image'`
    await sql.unsafe(migration)
    const [row] =
      await sql`SELECT credits_per_image, active FROM billing_model_prices WHERE model = 'gemini-3-pro-image'`
    expect(row).toEqual({ credits_per_image: 420, active: false })
  })
})
