import { afterAll, describe, expect, it } from 'bun:test'
import journal from '../../drizzle/meta/_journal.json'
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
    expect(rows).toHaveLength(journal.entries.length)
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

  it('removes the retired domain handoff and conversation claim tables', async () => {
    const rows = await connection.client.unsafe(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('domain_migrations', 'domain_migration_chunks', 'agent_device_claims')
    `)
    expect(rows).toEqual([])
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

  it('indexes model calls by time for the Admin cache summary', async () => {
    const rows = (await connection.client.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agent_model_calls'
    `)) as IndexMetadata[]
    expect(rows.map((row) => row.indexname)).toContain('idx_agent_model_calls_started_at')
  })

  it('is idempotent across process restarts', async () => {
    await runMigrations(databaseUrl)
    await runMigrations(databaseUrl)
    const rows = await connection.client.unsafe(
      'SELECT id FROM drizzle.__drizzle_migrations ORDER BY id',
    )
    expect(rows).toHaveLength(journal.entries.length)
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

  it('refuses attachment rollback while pending or ready leased originals remain', async () => {
    const now = new Date()
    await connection.client`INSERT INTO users (id, username, password_hash, status, created_at, updated_at) VALUES ('rollback-attachment-owner', 'rollback-attachment-owner', 'fixture', 'active', ${now}, ${now})`
    const rollback = await Bun.file(
      new URL('../../drizzle/rollback/0048_conversation_attachments.down.sql', import.meta.url),
    ).text()
    try {
      for (const status of ['pending', 'ready']) {
        await connection.client`INSERT INTO media_objects (id, user_id, sha256, bytes, content_type, status, attachment_managed, attachment_lease_until, reserved_bytes, staging_key, expires_at, created_at, updated_at) VALUES (${status}, 'rollback-attachment-owner', ${status}, 1, 'image/png', ${status}, true, ${now}, 1, ${status}, ${now}, ${now}, ${now})`
        await expect(
          connection.client.begin(async (tx) => {
            await tx.unsafe(rollback)
          }),
        ).rejects.toThrow('attachment')
        await connection.client`DELETE FROM media_objects WHERE id = ${status}`
      }
    } finally {
      await connection.client`DELETE FROM users WHERE id = 'rollback-attachment-owner'`
    }
  })

  it('retains paid phase authorization when a rollback would discard it', async () => {
    const now = new Date()
    await connection.client`INSERT INTO users (id, username, password_hash, status, created_at, updated_at) VALUES ('rollback-phase-owner', 'rollback-phase-owner', 'fixture', 'active', ${now}, ${now})`
    try {
      await connection.client`INSERT INTO agent_batches (id, user_id, origin_turn_id, tool_call_id, experience, created_at, updated_at) VALUES ('rollback-phase', 'rollback-phase-owner', 'turn', 'call', 'chat', ${now}, ${now})`
      await connection.client`INSERT INTO agent_batch_plans (batch_id, version, title, rule, digest, item_count, estimate_snapshot, confirmation, created_at) VALUES ('rollback-phase', 1, 'phase', 'rule', 'digest', 1, '{}'::jsonb, '{"phase":"analysis","itemKeys":["detail"],"requiresResume":false}'::jsonb, ${now})`
      const rollback = await Bun.file(
        new URL('../../drizzle/rollback/0055_agent_batch_confirmation.down.sql', import.meta.url),
      ).text()
      await expect(
        connection.client.begin(async (tx) => {
          await tx.unsafe(rollback)
        }),
      ).rejects.toThrow('phase authorization')
      const [saved] =
        await connection.client`SELECT confirmation FROM agent_batch_plans WHERE batch_id = 'rollback-phase'`
      expect(saved.confirmation).toEqual({
        phase: 'analysis',
        itemKeys: ['detail'],
        requiresResume: false,
      })
      await connection.client`UPDATE agent_batch_plans SET confirmation = NULL WHERE batch_id = 'rollback-phase'`
      await connection.client`INSERT INTO agent_batch_items (batch_id, version, key, ordinal, kind, inputs, prompt, params, dependencies, source_analysis) VALUES ('rollback-phase', 1, 'generate', 0, 'generation', '[]'::jsonb, 'concrete prompt', '{}'::jsonb, '[]'::jsonb, '[{"itemKey":"inspected","taskId":"independent-analysis","attempt":1}]'::jsonb)`
      await expect(
        connection.client.begin(async (tx) => {
          await tx.unsafe(rollback)
        }),
      ).rejects.toThrow('phase authorization')
    } finally {
      await connection.client`DELETE FROM users WHERE id = 'rollback-phase-owner'`
    }
  })

  it('applies every rollback in reverse order and can migrate forward again', async () => {
    const rollbackDirectory = new URL('../../drizzle/rollback/', import.meta.url)
    // Newest first, one down file per journal entry: a migration without a rollback fails here.
    for (const { tag } of [...journal.entries].reverse()) {
      const rollback = Bun.file(new URL(`${tag}.down.sql`, rollbackDirectory))
      expect(await rollback.exists(), `drizzle/rollback/${tag}.down.sql`).toBe(true)
      await connection.client.unsafe(await rollback.text())
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
    expect(restored).toHaveLength(journal.entries.length)
  })
})
