import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { subscriptions } from '@image-playground/db/billing'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'

const TEST_DB = await resetTestDatabase('billing_cli_hooks')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, 'operator-config.json')
const { ensureBillingMigrations } = await import('@image-playground/db')
await ensureBillingMigrations(TEST_DB)

const { close: closeDb, db, schema } = await import('../../../db/client')
const { privateTaskHooks } = await import('../../../modules/billing/service')

const USER = 'cli-hooks-user'

/** 每个账号同一时刻只能有一条 active 订阅：先清掉再写这一条。 */
async function subscribe(
  startsAt: number,
  endsAt: number,
  status: 'active' | 'expired' = 'active',
) {
  const now = Date.now()
  await db.delete(subscriptions)
  await db.insert(subscriptions).values({
    id: `sub-${startsAt}-${status}`,
    user_id: USER,
    plan_id: 'starter',
    period_months: 1,
    starts_at: startsAt,
    ends_at: endsAt,
    status,
    created_at: now,
    updated_at: now,
  })
}

function canSubmit(imageSize: string) {
  return db.transaction((tx) =>
    privateTaskHooks.canSubmitTask!({
      tx,
      userId: USER,
      model: 'gemini-3-pro-image',
      request: { image_size: imageSize },
    }),
  )
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE ${subscriptions}, ${schema.users} CASCADE`)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: USER,
    password_hash: 'x',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
})

afterAll(async () => {
  await closeDb()
})

describe('4K membership gate', () => {
  it('lets anyone submit below 4K and rejects 4K without a subscription', async () => {
    expect(await canSubmit('2K')).toBe(true)
    expect(await canSubmit('4K')).toBe(false)
  })

  it('accepts 4K only while an active subscription is within its period', async () => {
    const now = Date.now()
    await subscribe(now - 60_000, now - 1_000)
    expect(await canSubmit('4K')).toBe(false)
    await subscribe(now + 60_000, now + 120_000)
    expect(await canSubmit('4K')).toBe(false)
    await subscribe(now - 60_000, now + 60_000, 'expired')
    expect(await canSubmit('4K')).toBe(false)
    await subscribe(now - 1_000, now + 60_000)
    expect(await canSubmit('4K')).toBe(true)
  })
})

describe('CLI account summary', () => {
  it('reports the balance and the same membership definition', async () => {
    const now = Date.now()
    const before = await privateTaskHooks.accountSummary!({ userId: USER, now })
    expect(before).not.toBeNull()
    expect(before!.isMember).toBe(false)
    expect(typeof before!.credits).toBe('number')
    await subscribe(now - 1_000, now + 60_000)
    expect((await privateTaskHooks.accountSummary!({ userId: USER, now }))?.isMember).toBe(true)
  })
})
