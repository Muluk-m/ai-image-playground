import { afterAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import journal from '../../drizzle/meta/_journal.json'
import { createDb } from '../client'
import { runMigrations } from '../migrate'
import { resetTestDatabase } from '../testing'
import { verifySchema } from '../verify-schema'

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
const migrationsDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url))

async function migrationFileHash(tag: string): Promise<string> {
  const query = await Bun.file(new URL(`../../drizzle/${tag}.sql`, import.meta.url)).text()
  return createHash('sha256').update(query).digest('hex')
}

function migrationStamp(row: { hash: string; created_at: string | number | bigint }) {
  return { hash: row.hash, created_at: String(row.created_at) }
}

/** Applies a historical journal onto an empty database. Later files stay unread. */
async function migrateUntil(
  databaseUrl: string,
  lastTag: string,
  omittedTags: readonly string[] = [],
): Promise<void> {
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag)
  if (end < 0) throw new Error(`missing migration ${lastTag}`)
  const entries = journal.entries
    .slice(0, end + 1)
    .filter((entry) => !omittedTags.includes(entry.tag))
  const dir = await mkdtemp(join(tmpdir(), 'aip-migrate-'))
  const client = new SQL(databaseUrl, { max: 1 })
  try {
    await mkdir(join(dir, 'meta'))
    await Bun.write(
      join(dir, 'meta/_journal.json'),
      JSON.stringify({ version: journal.version, dialect: journal.dialect, entries }),
    )
    for (const entry of entries) {
      await symlink(join(migrationsDirectory, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    await migrate(drizzle(client), { migrationsFolder: dir })
  } finally {
    await client.close()
    await rm(dir, { recursive: true, force: true })
  }
}

async function withEmptyDatabase(name: string, run: (url: string) => Promise<void>): Promise<void> {
  const configured = process.env.TEST_DATABASE_URL?.trim()
  if (!configured) throw new Error('TEST_DATABASE_URL is required')
  const base = new URL(configured)
  const databaseName = `aip_test_${name}`
  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'
  const admin = new SQL(adminUrl.toString(), { max: 1 })
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
    await run(url.toString())
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.close()
  }
}

afterAll(async () => {
  await connection.close()
})

describe('runMigrations', () => {
  it('upgrades deployed creation history to editable operator overrides without losing existing rows', async () => {
    await withEmptyDatabase('operator_overrides_upgrade', async (url) => {
      await migrateUntil(url, '0084_generation_images_soft_delete')
      await runMigrations(url)
      const sql = new SQL(url, { max: 1 })
      try {
        await sql`INSERT INTO operator_config_overrides (key, value, baseline_value, operator_id, reason, updated_at)
          VALUES ('generation:daily-images', '7'::jsonb, '0'::jsonb, 'test-operator', 'quota verification', now())`
        await runMigrations(url)
        const [saved] =
          await sql`SELECT key, value, reason FROM operator_config_overrides WHERE key = 'generation:daily-images'`
        expect(saved).toEqual({
          key: 'generation:daily-images',
          value: 7,
          reason: 'quota verification',
        })
        const [revision] = await sql`SELECT revision FROM operator_config_state WHERE id = 1`
        expect(revision.revision).toBe(0)
      } finally {
        await sql.close()
      }
    })
  }, 30_000)

  it('retains nullable original prompts and indexes the admin chronology', async () => {
    const [column] =
      await connection.client`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_generation_drafts' AND column_name = 'drafted_prompt'`
    expect(column).toEqual({ data_type: 'text', is_nullable: 'YES' })
    const indexes =
      await connection.client`SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_agent_generation_drafts_created', 'idx_tasks_agent_submitted')`
    expect(indexes).toHaveLength(2)
    expect(
      indexes.find(
        (index: { indexname: string; indexdef: string }) =>
          index.indexname === 'idx_tasks_agent_submitted',
      )?.indexdef,
    ).toContain('WHERE (agent_conversation_id IS NOT NULL)')
  })

  it('indexes confirmed drafts by task', async () => {
    const [index] =
      await connection.client`SELECT indexdef FROM pg_indexes WHERE tablename = 'agent_generation_drafts' AND indexname = 'idx_agent_generation_drafts_task'`
    expect(index?.indexdef).toContain('(task_id) WHERE (task_id IS NOT NULL)')
  })

  it('indexes ordered context queries within a container', async () => {
    const [index] =
      await connection.client`SELECT indexdef FROM pg_indexes WHERE tablename = 'server_logs' AND indexname = 'idx_server_logs_instance_at'`
    expect(index?.indexdef).toContain('(instance, at DESC, id DESC)')
  })

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

  it('stores the optional production document as PostgreSQL JSONB', async () => {
    const rows = await connection.client`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_conversations' AND column_name = 'production'
    `
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }])
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

  it('refuses to migrate when an older journal entry was never applied', async () => {
    await runMigrations(databaseUrl)
    // Two PRs merged out of order look like this: a newer stamp applied, an older one missing.
    const middle = journal.entries.find((entry) => entry.when === 1794300000000)!
    const [row] = await connection.client.unsafe<{ hash: string; created_at: string }[]>(
      `DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${middle.when} RETURNING hash, created_at`,
    )
    try {
      await expect(runMigrations(databaseUrl)).rejects.toThrow(middle.tag)
    } finally {
      // The documented recovery: record the missing migration with its hash and journal stamp.
      await connection.client.unsafe(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${await migrationFileHash(middle.tag)}', ${middle.when})`,
      )
    }
    await runMigrations(databaseUrl)
    expect(row?.created_at).toBeDefined()
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

  it('retains stage authorization scope and spend history during rollback', async () => {
    const now = new Date()
    await connection.client`INSERT INTO users (id, username, password_hash, status, created_at, updated_at) VALUES ('rollback-stage-owner', 'rollback-stage-owner', 'fixture', 'active', ${now}, ${now})`
    try {
      await connection.client`INSERT INTO agent_conversations (id, user_id, title, created_at, updated_at) VALUES ('rollback-stage-conversation', 'rollback-stage-owner', 'stage', ${now}, ${now})`
      await connection.client`INSERT INTO canvas_projects (id, user_id, name, revision, document, element_count, conversation_id, receipts, created_at, updated_at) VALUES ('rollback-stage-project', 'rollback-stage-owner', 'stage', 1, '{"version":1,"elements":[]}'::jsonb, 0, 'rollback-stage-conversation', '[]'::jsonb, ${now}, ${now})`
      const rollback = await Bun.file(
        new URL('../../drizzle/rollback/0074_agent_stage_authorizations.down.sql', import.meta.url),
      ).text()
      const [createdAt] = await connection.client<
        { data_type: string }[]
      >`SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_stage_authorizations' AND column_name = 'created_at'`
      expect(createdAt?.data_type).toBe('timestamp with time zone')
      for (const status of ['pending', 'active', 'exhausted', 'ended']) {
        const state = { status, nodeIds: ['authorized-node'], budgetCap: 20, spentCredits: 10 }
        await connection.client`INSERT INTO agent_stage_authorizations (id, user_id, conversation_id, project_id, proposal_key, state, created_at, updated_at) VALUES ('rollback-stage', 'rollback-stage-owner', 'rollback-stage-conversation', 'rollback-stage-project', 'proposal', ${state}::jsonb, ${now}, ${now}) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state`
        await expect(
          connection.client.begin(async (tx) => {
            await tx.unsafe(rollback)
          }),
        ).rejects.toThrow('stage authorization history')
        const [saved] =
          await connection.client`SELECT state FROM agent_stage_authorizations WHERE id = 'rollback-stage'`
        expect(saved.state).toEqual(state)
      }
    } finally {
      await connection.client`DELETE FROM users WHERE id = 'rollback-stage-owner'`
    }
  })

  it('migrates an empty database through 0073 and then 0074', async () => {
    // 按位置找这两条，后面再加迁移不必改这里。
    const reconcileAt = journal.entries.findIndex(
      (entry) => entry.tag === '0073_reconcile_schedule',
    )
    expect(journal.entries[reconcileAt]).toMatchObject({
      idx: 73,
      when: 1792400000000,
      tag: '0073_reconcile_schedule',
    })
    expect(journal.entries[reconcileAt + 1]).toMatchObject({
      idx: 74,
      when: 1792500000000,
      tag: '0074_agent_stage_authorizations',
    })
    const rows = await connection.client<{ hash: string; created_at: string | number }[]>`
      SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
    `
    expect(rows).toHaveLength(journal.entries.length)
    expect(migrationStamp(rows[reconcileAt]!)).toEqual({
      hash: await migrationFileHash('0073_reconcile_schedule'),
      created_at: '1792400000000',
    })
    expect(migrationStamp(rows[reconcileAt + 1]!)).toEqual({
      hash: await migrationFileHash('0074_agent_stage_authorizations'),
      created_at: '1792500000000',
    })
    const [stage] = await connection.client<{ name: string | null }[]>`
      SELECT to_regclass('public.agent_stage_authorizations')::text AS name
    `
    expect(stage?.name).toBe('agent_stage_authorizations')
    const [reconcile] = await connection.client<{ data_type: string }[]>`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'reconcile_started_at'
    `
    expect(reconcile?.data_type).toBe('timestamp with time zone')
  })

  // Replaying 73 migrations on a fresh database takes about two seconds when CI is idle
  // and crossed bun's five-second default under load (2014ms green, 5000ms timeout).
  it('upgrades a database already at 0073 to 0074 without replaying reconcile', async () => {
    await withEmptyDatabase('upgrade_0074', async (url) => {
      const reconcileAt = journal.entries.findIndex(
        (entry) => entry.tag === '0073_reconcile_schedule',
      )
      await migrateUntil(url, '0073_reconcile_schedule')
      const client = new SQL(url, { max: 1 })
      try {
        const before = await client<{ hash: string; created_at: string | number }[]>`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
        `
        expect(before).toHaveLength(reconcileAt + 1)
        expect(migrationStamp(before.at(-1)!)).toEqual({
          hash: await migrationFileHash('0073_reconcile_schedule'),
          created_at: '1792400000000',
        })
        const [missing] = await client<{ name: string | null }[]>`
          SELECT to_regclass('public.agent_stage_authorizations')::text AS name
        `
        expect(missing?.name).toBeNull()
        const kept = new Date('2026-01-02T03:04:05.000Z')
        await client`INSERT INTO tasks (id, provider, model, status, reconciliation_required, request_payload, submitted_at, reconcile_started_at) VALUES ('upgrade-sentinel', 'openai-compat', 'fixture', 'reconciling', true, '{"device_id":"fixture","prompt":"one","n":1}'::jsonb, ${kept}, ${kept})`

        await runMigrations(url)

        const after = await client<{ hash: string; created_at: string | number }[]>`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id
        `
        expect(after).toHaveLength(journal.entries.length)
        expect(migrationStamp(after[reconcileAt]!)).toEqual(migrationStamp(before.at(-1)!))
        expect(migrationStamp(after[reconcileAt + 1]!)).toEqual({
          hash: await migrationFileHash('0074_agent_stage_authorizations'),
          created_at: '1792500000000',
        })
        const [stage] = await client<{ name: string | null }[]>`
          SELECT to_regclass('public.agent_stage_authorizations')::text AS name
        `
        expect(stage?.name).toBe('agent_stage_authorizations')
        const [saved] = await client<{ reconcile_started_at: Date }[]>`
          SELECT reconcile_started_at FROM tasks WHERE id = 'upgrade-sentinel'
        `
        expect(new Date(saved.reconcile_started_at).toISOString()).toBe(kept.toISOString())
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('upgrades production with password reset but without the earlier refresh migration', async () => {
    await withEmptyDatabase('refresh_identity_production', async (url) => {
      await migrateUntil(url, journal.entries.find((entry) => entry.when === 1794300000000)!.tag)
      await runMigrations(url)
      await expect(verifySchema(url)).resolves.toMatchObject({
        migrations: journal.entries.length - 1,
      })
      const client = new SQL(url, { max: 1 })
      try {
        const rows =
          await client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        expect(
          rows.some(
            (row: { created_at: string | number }) => Number(row.created_at) === 1794250000000,
          ),
        ).toBe(false)
        expect(rows.at(-1)).toMatchObject({
          hash: await migrationFileHash('0094_web_refresh_request_identity_forward'),
          created_at: '1794400000000',
        })
        const [column] =
          await client`SELECT is_nullable FROM information_schema.columns WHERE table_name = 'user_retired_refresh_tokens' AND column_name = 'request_key_hash'`
        expect(column.is_nullable).toBe('YES')
        await runMigrations(url)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('upgrades test with the original refresh migration and no password reset migration', async () => {
    await withEmptyDatabase('refresh_identity_test', async (url) => {
      const passwordReset = journal.entries.find((entry) => entry.when === 1794300000000)!
      await migrateUntil(url, '0093_web_refresh_request_identity', [passwordReset.tag])
      await runMigrations(url)
      const client = new SQL(url, { max: 1 })
      try {
        const rows =
          await client`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        expect(rows).toHaveLength(journal.entries.length)
        expect(
          rows.filter(
            (row: { created_at: string | number }) => Number(row.created_at) === 1794250000000,
          ),
        ).toHaveLength(1)
        await runMigrations(url)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('upgrades the pure-main journal through 0084 without inventing historical applications', async () => {
    await withEmptyDatabase('upgrade_main', async (url) => {
      // origin/main has 0000–0078 (no 0013), then 0082, 0083, 0084; neither original ran.
      await migrateUntil(url, '0084_generation_images_soft_delete', [
        '0079_task_metering',
        '0081_cli_device_oauth',
      ])
      const client = new SQL(url, { max: 1 })
      try {
        const before =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        expect(before).toHaveLength(81)
        const [missing] =
          await client`SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'metering'`
        expect(missing.count).toBe(0)
        const [oauth] = await client`SELECT created_at FROM oauth_clients WHERE id = 'muvloom-cli'`
        await client`INSERT INTO tasks (id, provider, model, status, request_payload, submitted_at) VALUES ('main-upgrade-sentinel', 'openai-compat', 'fixture', 'queued', '{}'::jsonb, now())`

        await runMigrations(url)

        const after =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        expect(after.slice(0, before.length)).toEqual(before)
        expect(after).toHaveLength(journal.entries.length - 2)
        // Only migrations newer than main's last applied one run, in journal order.
        const expectedForwardMigrations = [
          {
            hash: await migrationFileHash('0085_task_metering_forward'),
            created_at: '1793600000000',
          },
          {
            hash: await migrationFileHash('0086_operator_config_overrides'),
            created_at: '1793700000000',
          },
          {
            hash: await migrationFileHash('0087_web_session_refresh'),
            created_at: '1793800000000',
          },
          {
            hash: await migrationFileHash('0088_upstream_api_secrets'),
            created_at: '1793900000000',
          },
          {
            hash: await migrationFileHash('0089_admin_filter_indexes'),
            created_at: '1794000000000',
          },
          {
            hash: await migrationFileHash('0090_announcements'),
            created_at: '1794100000000',
          },
          {
            hash: await migrationFileHash('0091_gpt_direct_keys'),
            created_at: '1794200000000',
          },
        ]
        for (const entry of journal.entries.filter((entry) => entry.when > 1794200000000)) {
          expectedForwardMigrations.push({
            hash: await migrationFileHash(entry.tag),
            created_at: String(entry.when),
          })
        }
        expect(after.slice(before.length).map(migrationStamp)).toEqual(expectedForwardMigrations)
        const columns =
          await client`SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'metering'`
        expect(columns).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }])
        const [saved] = await client`SELECT metering FROM tasks WHERE id = 'main-upgrade-sentinel'`
        expect(saved.metering).toBeNull()
        const [retained] =
          await client`SELECT created_at FROM oauth_clients WHERE id = 'muvloom-cli'`
        expect(retained).toEqual(oauth)
        await runMigrations(url)
        expect(
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        ).toEqual(after)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('runs both forward equivalents when upgrading main at 0082', async () => {
    await withEmptyDatabase('upgrade_main_0082', async (url) => {
      await migrateUntil(url, '0082_upstream_scheduler', [
        '0079_task_metering',
        '0081_cli_device_oauth',
      ])
      const client = new SQL(url, { max: 1 })
      try {
        await runMigrations(url)
        const [oauth] = await client`SELECT id FROM oauth_clients WHERE id = 'muvloom-cli'`
        expect(oauth?.id).toBe('muvloom-cli')
        const columns =
          await client`SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'metering'`
        expect(columns).toEqual([{ data_type: 'jsonb' }])
        const rows =
          await client`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
        expect(rows).toHaveLength(journal.entries.length - 2)
        expect(
          rows.map((row: { created_at: string | number }) => String(row.created_at)),
        ).not.toContain('1793000000000')
        expect(
          rows.map((row: { created_at: string | number }) => String(row.created_at)),
        ).not.toContain('1793200000000')
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('preserves test history and metering when originals were already applied', async () => {
    await withEmptyDatabase('upgrade_test_0081', async (url) => {
      await migrateUntil(url, '0081_cli_device_oauth')
      const client = new SQL(url, { max: 1 })
      try {
        const before =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        const metering = { billingMode: 'credits', rate: 17 }
        await client`INSERT INTO tasks (id, provider, model, status, request_payload, metering, submitted_at) VALUES ('test-upgrade-sentinel', 'openai-compat', 'fixture', 'queued', '{}'::jsonb, ${metering}::jsonb, now())`
        const [oauth] = await client`SELECT created_at FROM oauth_clients WHERE id = 'muvloom-cli'`
        await runMigrations(url)
        const after =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        expect(after.slice(0, before.length)).toEqual(before)
        expect(after).toHaveLength(journal.entries.length)
        const [saved] = await client`SELECT metering FROM tasks WHERE id = 'test-upgrade-sentinel'`
        expect(saved.metering).toEqual(metering)
        const [retained] =
          await client`SELECT created_at FROM oauth_clients WHERE id = 'muvloom-cli'`
        expect(retained).toEqual(oauth)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('still rejects unrelated gaps, missing older replacements and mismatched replacement hashes', async () => {
    await withEmptyDatabase('upgrade_main_refusals', async (url) => {
      await migrateUntil(url, '0084_generation_images_soft_delete', [
        '0079_task_metering',
        '0081_cli_device_oauth',
      ])
      const client = new SQL(url, { max: 1 })
      try {
        const originalHash = await migrationFileHash('0083_cli_device_oauth')
        await client`UPDATE drizzle.__drizzle_migrations SET hash = 'not-the-audited-sql' WHERE created_at = 1793400000000`
        const mismatched =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        await expect(runMigrations(url)).rejects.toThrow(
          'Applied migration supersession hash mismatch: 0083_cli_device_oauth',
        )
        expect(
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        ).toEqual(mismatched)
        await client`UPDATE drizzle.__drizzle_migrations SET hash = ${originalHash} WHERE created_at = 1793400000000`

        for (const tag of ['0083_cli_device_oauth', '0078_generation_commands_recent']) {
          const entry = journal.entries.find((candidate) => candidate.tag === tag)!
          const [removed] =
            await client`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when} RETURNING id, hash, created_at`
          const before =
            await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
          await expect(runMigrations(url)).rejects.toThrow(tag)
          expect(
            await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
          ).toEqual(before)
          await client`INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at) VALUES (${removed.id}, ${removed.hash}, ${removed.created_at})`
        }
        const [missing] =
          await client`SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'metering'`
        expect(missing.count).toBe(0)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('rolls back forward schema and history together when the catch-up migration fails', async () => {
    await withEmptyDatabase('upgrade_main_atomic', async (url) => {
      await migrateUntil(url, '0082_upstream_scheduler', [
        '0079_task_metering',
        '0081_cli_device_oauth',
      ])
      const client = new SQL(url, { max: 1 })
      try {
        const before =
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`
        await client.unsafe(`CREATE FUNCTION public.reject_metering_migration() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.created_at = 1793600000000 THEN RAISE EXCEPTION 'metering history rejected'; END IF;
            RETURN NEW;
          END;
        $$`)
        await client.unsafe(`CREATE TRIGGER reject_metering_migration BEFORE INSERT ON drizzle.__drizzle_migrations
          FOR EACH ROW EXECUTE FUNCTION public.reject_metering_migration()`)
        await expect(runMigrations(url)).rejects.toThrow()
        expect(
          await client`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
        ).toEqual(before)
        const [oauth] = await client`SELECT to_regclass('public.oauth_clients')::text AS name`
        expect(oauth.name).toBeNull()
        const columns =
          await client`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'tasks' AND column_name = 'metering') OR (table_name = 'generation_images' AND column_name = 'deleted_at'))`
        expect(columns).toEqual([])
        await client.unsafe(
          'DROP TRIGGER reject_metering_migration ON drizzle.__drizzle_migrations',
        )
        await client.unsafe('DROP FUNCTION public.reject_metering_migration()')
        await runMigrations(url)
        const [applied] =
          await client`SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations WHERE created_at = 1793600000000`
        expect(applied.count).toBe(1)
      } finally {
        await client.close()
      }
    })
  }, 30_000)

  it('indexes pending tool-gate cards by conversation (0076)', async () => {
    const [index] = await connection.client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_agent_messages_pending_gate'
    `
    expect(index?.indexdef).toContain('(conversation_id)')
    expect(index?.indexdef).toContain('deleted_at IS NULL')
    expect(index?.indexdef).toContain('awaiting_confirmation')
  })

  it('indexes consumed inbox rows by turn (0075)', async () => {
    const [index] = await connection.client<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_agent_inbox_consumed_turn'
    `
    expect(index?.indexdef).toContain('(conversation_id, consumed_turn_id)')
    expect(index?.indexdef).toContain("WHERE (status = 'consumed'::text)")
  })

  // Same budget as the upgrade above: every rollback plus a replay of all migrations on the suite
  // database. It finished well under a second locally but crossed bun's five-second default on a
  // loaded runner (run 39234295912), with nothing else touching this database.
  it('applies every rollback in reverse order and can migrate forward again', async () => {
    const rollbackDirectory = new URL('../../drizzle/rollback/', import.meta.url)
    // Newest first, one down file per journal entry: a migration without a rollback fails here.
    for (const { tag } of [...journal.entries].reverse()) {
      const rollback = Bun.file(new URL(`${tag}.down.sql`, rollbackDirectory))
      expect(await rollback.exists(), `drizzle/rollback/${tag}.down.sql`).toBe(true)
      await connection.client.unsafe(await rollback.text())
      if (tag === '0059_production_document') {
        const columns = await connection.client<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='agent_conversations'
        `
        expect(columns.length).toBeGreaterThan(0)
        expect(columns.some((column) => column.column_name === 'production')).toBe(false)
      }
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
    const production = await connection.client`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agent_conversations' AND column_name='production'
    `
    expect(production).toEqual([{ data_type: 'jsonb' }])
  }, 30_000)
})
