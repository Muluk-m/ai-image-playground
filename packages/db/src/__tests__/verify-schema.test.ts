import { describe, expect, it } from 'bun:test'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'
import { EXPECTED_INDEXES, EXPECTED_TABLES, verifySchema } from '../verify-schema'

const databaseUrl = await resetTestDatabase('schema_verifier')

describe('verifySchema', () => {
  it('accepts the complete committed schema', async () => {
    await expect(verifySchema(databaseUrl)).resolves.toMatchObject({
      tables: EXPECTED_TABLES.length,
      indexes: EXPECTED_INDEXES.length,
      migrations: 48,
    })
  })

  it('rejects a missing or non-JSONB production document even when migrations are recorded', async () => {
    const handle = createDb(databaseUrl)
    try {
      await handle.client.unsafe('ALTER TABLE agent_conversations DROP COLUMN production')
      await expect(verifySchema(databaseUrl)).rejects.toThrow(
        'agent_conversations.production must be jsonb',
      )
      await handle.client.unsafe('ALTER TABLE agent_conversations ADD COLUMN production text')
      await expect(verifySchema(databaseUrl)).rejects.toThrow(
        'agent_conversations.production must be jsonb',
      )
    } finally {
      await handle.client.unsafe('ALTER TABLE agent_conversations DROP COLUMN IF EXISTS production')
      await handle.client.unsafe('ALTER TABLE agent_conversations ADD COLUMN production jsonb')
      await handle.close()
    }
    await expect(verifySchema(databaseUrl)).resolves.toMatchObject({ migrations: 48 })
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
