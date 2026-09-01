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
    expect(rows).toHaveLength(6)
    expect(rows[0]).toMatchObject({ id: 1 })
    expect(rows[1]).toMatchObject({ id: 2 })
    expect(rows[2]).toMatchObject({ id: 3 })
    expect(rows[3]).toMatchObject({ id: 4 })
    expect(rows[4]).toMatchObject({ id: 5 })
    expect(rows[5]).toMatchObject({ id: 6 })
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
    expect(byName.upstream_status?.data_type).toBe('integer')
    expect(byName.upstream_body?.data_type).toBe('text')
  })

  it('stores quota dates as PostgreSQL dates', async () => {
    const [quotaDate] = (await connection.client.unsafe(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'daily_quota' AND column_name = 'date'
    `)) as ColumnMetadata[]
    expect(quotaDate?.data_type).toBe('date')
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
    expect(rows).toHaveLength(6)
  })

  it('applies every rollback in reverse order and can migrate forward again', async () => {
    const rollbackDirectory = new URL('../../drizzle/rollback/', import.meta.url)
    for (const file of [
      '0005_left_annihilus.down.sql',
      '0004_damp_tony_stark.down.sql',
      '0003_perfect_night_nurse.down.sql',
      '0002_careless_scrambler.down.sql',
      '0001_blushing_liz_osborn.down.sql',
      '0000_daffy_the_enforcers.down.sql',
    ]) {
      await connection.client.unsafe(await Bun.file(new URL(file, rollbackDirectory)).text())
    }

    const [rolledBack] = await connection.client<
      {
        tasks: string | null
        audits: string | null
        migrations: string | null
      }[]
    >`
      SELECT
        to_regclass('public.tasks')::text AS tasks,
        to_regclass('public.operator_audits')::text AS audits,
        to_regclass('drizzle.__drizzle_migrations')::text AS migrations
    `
    expect(rolledBack).toEqual({ tasks: null, audits: null, migrations: null })

    await runMigrations(databaseUrl)
    const restored = await connection.client.unsafe(
      'SELECT id FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    expect(restored).toHaveLength(6)
  })
})
