import { afterAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { ensureBillingMigrations } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SQL } from 'bun'

const database = await resetTestDatabase('grok_video_lite_price')
await ensureBillingMigrations(database)
const sql = new SQL(database)
const migration = readFileSync(
  new URL('../migrations/0016_grok_video_lite_price.sql', import.meta.url),
  'utf8',
)
afterAll(async () => {
  await sql.close()
})

describe('Lite price migration', () => {
  it('copies the operator price and disabled state without changing legacy or existing Lite prices', async () => {
    await sql`DELETE FROM billing_model_prices WHERE model IN ('grok-imagine-video', 'grok-imagine-video-1.5-lite')`
    await sql`INSERT INTO billing_model_prices (model, credits_per_image, unit, active, updated_at) VALUES ('grok-imagine-video', 74, 'second', false, NOW())`
    await sql.unsafe(migration)
    const rows =
      await sql`SELECT model, credits_per_image, unit, active FROM billing_model_prices WHERE model IN ('grok-imagine-video', 'grok-imagine-video-1.5-lite') ORDER BY model`
    expect(rows).toEqual([
      { model: 'grok-imagine-video', credits_per_image: 74, unit: 'second', active: false },
      {
        model: 'grok-imagine-video-1.5-lite',
        credits_per_image: 74,
        unit: 'second',
        active: false,
      },
    ])
    await sql`UPDATE billing_model_prices SET credits_per_image = 81, active = true WHERE model = 'grok-imagine-video-1.5-lite'`
    await sql.unsafe(migration)
    const current = await sql<
      { credits_per_image: number; active: boolean }[]
    >`SELECT credits_per_image, active FROM billing_model_prices WHERE model = 'grok-imagine-video-1.5-lite'`
    expect(current).toEqual([{ credits_per_image: 81, active: true }])
  })
})
