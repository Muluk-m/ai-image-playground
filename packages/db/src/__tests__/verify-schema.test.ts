import { describe, expect, it } from 'bun:test'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'
import { EXPECTED_INDEXES, EXPECTED_TABLES, verifySchema } from '../verify-schema'

const databaseUrl = await resetTestDatabase('schema_verifier')

describe('verifySchema', () => {
  it('accepts the complete committed schema', async () => {
    await expect(verifySchema(databaseUrl)).resolves.toEqual({
      tables: EXPECTED_TABLES.length,
      indexes: EXPECTED_INDEXES.length,
      migrations: 3,
    })
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
