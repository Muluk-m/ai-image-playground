import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '../client'
import { runMigrations } from '../migrate'
import { resetTestDatabase } from '../testing'

interface ColumnMetadata {
  column_name: string
  data_type: string
  is_generated: string
}

interface IndexMetadata {
  indexname: string
}

const databaseUrl = await resetTestDatabase('db_migrate')
const connection = createDb(databaseUrl)

afterAll(async () => {
  await connection.close()
})

describe('runMigrations', () => {
  it('records an ordered migration version', async () => {
    const rows = await connection.client.unsafe(
      'SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ id: 1 })
    expect(rows[1]).toMatchObject({ id: 2 })
    expect(rows[2]).toMatchObject({ id: 3 })
  })

  it('creates PostgreSQL-native JSONB and timestamptz columns', async () => {
    const rows = (await connection.client.unsafe(`
      SELECT column_name, data_type, is_generated
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks'
    `)) as ColumnMetadata[]
    const byName = Object.fromEntries(rows.map((row) => [row.column_name, row]))
    expect(byName.request_payload?.data_type).toBe('jsonb')
    expect(byName.submitted_at?.data_type).toBe('timestamp with time zone')
    expect(byName.device_id?.is_generated).toBe('ALWAYS')
  })

  it('creates the idempotency and operational indexes', async () => {
    const rows = (await connection.client.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'tasks'
    `)) as IndexMetadata[]
    const names = rows.map((row) => row.indexname)
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_tasks_anonymous_client_request_id',
        'idx_tasks_user_client_request_id',
        'idx_tasks_next_retry_at',
        'idx_tasks_user_time',
        'idx_tasks_admin_device_time',
      ]),
    )
  })

  it('is idempotent across process restarts', async () => {
    await runMigrations(databaseUrl)
    await runMigrations(databaseUrl)
    const rows = await connection.client.unsafe(
      'SELECT id FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    expect(rows).toHaveLength(3)
  })
})
