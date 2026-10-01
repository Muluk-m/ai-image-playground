import { describe, expect, it } from 'bun:test'
import journal from '../../drizzle/meta/_journal.json'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'
import { EXPECTED_INDEXES, EXPECTED_TABLES, verifySchema } from '../verify-schema'

const databaseUrl = await resetTestDatabase('schema_verifier')

describe('verifySchema', () => {
  it('accepts the complete committed schema', async () => {
    await expect(verifySchema(databaseUrl)).resolves.toMatchObject({
      tables: EXPECTED_TABLES.length,
      indexes: EXPECTED_INDEXES.length,
      migrations: journal.entries.length,
    })
  })

  it('rejects an incomplete migration ledger even when tables and indexes exist', async () => {
    const handle = createDb(databaseUrl)
    const [last] = await handle.client.unsafe(
      'DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT MAX(id) FROM drizzle.__drizzle_migrations) RETURNING *',
    )
    try {
      await expect(verifySchema(databaseUrl)).rejects.toThrow(
        `migration count ${journal.entries.length - 1} is below ${journal.entries.length}`,
      )
    } finally {
      await handle.client`INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (${last.id}, ${last.hash}, ${last.created_at})`
      await handle.close()
    }
  })

  it('reports a missing expected index', async () => {
    const handle = createDb(databaseUrl)
    try {
      await handle.client.unsafe('DROP INDEX idx_tasks_status')
    } finally {
      await handle.close()
    }
    await expect(verifySchema(databaseUrl)).rejects.toThrow('missing indexes: idx_tasks_status')
  })
})
