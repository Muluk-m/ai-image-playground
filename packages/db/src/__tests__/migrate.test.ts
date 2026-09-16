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
    expect(rows).toHaveLength(19)
    expect(rows[0]).toMatchObject({ id: 1 })
    expect(rows[1]).toMatchObject({ id: 2 })
    expect(rows[2]).toMatchObject({ id: 3 })
    expect(rows[3]).toMatchObject({ id: 4 })
    expect(rows[4]).toMatchObject({ id: 5 })
    expect(rows[5]).toMatchObject({ id: 6 })
    expect(rows[6]).toMatchObject({ id: 7 })
    expect(rows[7]).toMatchObject({ id: 8 })
    expect(rows[8]).toMatchObject({ id: 9 })
    expect(rows[9]).toMatchObject({ id: 10 })
    expect(rows[10]).toMatchObject({ id: 11 })
    expect(rows[11]).toMatchObject({ id: 12 })
    expect(rows[12]).toMatchObject({ id: 13 })
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
        'idx_tasks_user_status_time',
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
    expect(rows).toHaveLength(19)
  })

  it('backfills turn footers from turn-end events still inside the event window', async () => {
    // 直接跑迁移文件里的回填语句：钉的是真正会在部署上跑的那段 SQL。
    const migration = await Bun.file(
      new URL('../../drizzle/0016_agent_turn_summaries.sql', import.meta.url),
    ).text()
    const backfill = migration.split('--> statement-breakpoint').at(-1)!
    const now = new Date().toISOString()
    await connection.client.unsafe(`
      INSERT INTO agent_conversations (id, device_id, title, created_at, updated_at)
      VALUES ('conv-backfill', 'device-abcdefgh', '', '${now}', '${now}')
    `)
    await connection.client.unsafe(`
      INSERT INTO agent_turn_events (conversation_id, seq, turn_id, event, created_at)
      VALUES
        ('conv-backfill', 1, 'turn-1',
         '{"type":"turnStart","turnId":"turn-1","userMessageId":"u1"}'::jsonb, '${now}'),
        ('conv-backfill', 2, 'turn-1',
         '{"type":"turnEnd","turnId":"turn-1","durationMs":1200,"stopReason":"completed","usage":null,"cost":{"chat":42,"image":0,"video":0}}'::jsonb,
         '${now}'),
        ('conv-backfill', 3, 'turn-2',
         '{"type":"turnEnd","turnId":"turn-2","durationMs":300,"stopReason":"aborted","usage":null}'::jsonb,
         '${now}')
    `)
    await connection.client.unsafe('DELETE FROM agent_turns')

    await connection.client.unsafe(backfill)

    const rows = await connection.client.unsafe(`
      SELECT turn_id, duration_ms, stop_reason, cost
      FROM agent_turns
      WHERE conversation_id = 'conv-backfill'
      ORDER BY turn_id
    `)
    expect(rows).toEqual([
      {
        turn_id: 'turn-1',
        duration_ms: 1200,
        stop_reason: 'completed',
        cost: { chat: 42, image: 0, video: 0 },
      },
      { turn_id: 'turn-2', duration_ms: 300, stop_reason: 'aborted', cost: null },
    ])
    await connection.client.unsafe(`DELETE FROM agent_conversations WHERE id = 'conv-backfill'`)
  })

  it('applies every rollback in reverse order and can migrate forward again', async () => {
    const rollbackDirectory = new URL('../../drizzle/rollback/', import.meta.url)
    for (const file of [
      '0019_domain_migration.down.sql',
      '0018_cloud_projects.down.sql',
      '0017_agent_model_calls.down.sql',
      '0016_agent_turn_summaries.down.sql',
      '0015_chat_task_kind.down.sql',
      '0014_agent_task_link.down.sql',
      '0012_flowery_viper.down.sql',
      '0011_public_meggan.down.sql',
      '0010_calm_pestilence.down.sql',
      '0009_silky_the_fallen.down.sql',
      '0008_clean_fantastic_four.down.sql',
      '0007_shocking_gertrude_yorkes.down.sql',
      '0006_romantic_hiroim.down.sql',
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
        templates: string | null
        migrations: string | null
        model_calls: string | null
      }[]
    >`
      SELECT
        to_regclass('public.tasks')::text AS tasks,
        to_regclass('public.operator_audits')::text AS audits,
        to_regclass('public.user_templates')::text AS templates,
        to_regclass('drizzle.__drizzle_migrations')::text AS migrations,
        to_regclass('public.agent_model_calls')::text AS model_calls
    `
    expect(rolledBack).toEqual({
      tasks: null,
      audits: null,
      templates: null,
      migrations: null,
      model_calls: null,
    })

    await runMigrations(databaseUrl)
    const restored = await connection.client.unsafe(
      'SELECT id FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    expect(restored).toHaveLength(19)
  })
})
