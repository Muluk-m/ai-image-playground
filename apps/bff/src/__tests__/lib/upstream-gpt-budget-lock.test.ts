import { afterEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SQL } from 'bun'

process.env.DATABASE_URL = await resetTestDatabase('bff_gpt_budget_lock')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.GPT_DIRECT_ENABLED = 'true'
process.env.OPENAI_API_KEY = 'lock-key-aaaa'
process.env.PORT = '0'

const { directBudgetLockKey, recordDirectUsage, reserveDirectBudget } = await import(
  '../../lib/upstream/gpt-budget'
)
const { fingerprintOf } = await import('../../lib/upstream/gpt-key-config')
const { db, schema } = await import('../../db/client')

const fingerprint = fingerprintOf('lock-key-aaaa').fingerprint

afterEach(async () => {
  await db.delete(schema.gpt_direct_budget_holds)
  await db.delete(schema.gpt_direct_usage)
})

async function holdFingerprintLock(): Promise<SQL> {
  const client = new SQL(process.env.DATABASE_URL!, { max: 1 })
  await client`begin`
  await client`select pg_advisory_xact_lock(hashtext(${directBudgetLockKey(fingerprint)}))`
  return client
}

describe('direct budget lock', () => {
  it('does not reserve until usage committed under the same fingerprint lock is visible', async () => {
    const client = await holdFingerprintLock()
    try {
      await client`insert into gpt_direct_usage (id, model, images, cost_micro_usd, estimated, key_fingerprint, created_at)
        values ('race-usage', 'gpt-image-2.5-flare', 1, 5, false, ${fingerprint}, now())`
      let settled = false
      const pending = reserveDirectBudget({
        fingerprint,
        includeUnattributed: false,
        estimateMicroUsd: 1,
        capMicroUsd: 5,
      }).then((id) => {
        settled = true
        return id
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(settled).toBe(false)
      await client`commit`
      expect(await pending).toBeNull()
    } finally {
      await client`rollback`.catch(() => undefined)
      await client.close()
    }
  })

  it('waits for the fingerprint lock before recording usage', async () => {
    const client = await holdFingerprintLock()
    try {
      let settled = false
      const pending = recordDirectUsage({
        model: 'gpt-image-2.5-flare',
        images: 1,
        keyFingerprint: fingerprint,
      }).then(() => {
        settled = true
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(settled).toBe(false)
      await client`commit`
      await pending
      const rows = await db.select().from(schema.gpt_direct_usage)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.key_fingerprint).toBe(fingerprint)
    } finally {
      await client`rollback`.catch(() => undefined)
      await client.close()
    }
  })
})
