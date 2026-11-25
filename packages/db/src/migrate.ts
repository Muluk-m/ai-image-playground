import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const MIGRATION_LOCK = 'ai-image-playground:migrations'

interface ConcurrentIndexSpec {
  readonly migrationTag: string
  readonly name: string
  readonly table: string
  readonly requiredColumns: readonly string[]
  readonly createSql: string
}

/**
 * Indexes added to existing high-write tables (such as `tasks`) are built outside Drizzle's
 * migration transaction with `CREATE INDEX CONCURRENTLY` so live BFF/worker writes are never
 * blocked by a `SHARE` lock during rolling deploys. Each paired `.sql` migration skips DDL when
 * `pg_index.indisvalid` is already true, acquiring zero locks on the hot table while keeping fresh
 * empty databases self-contained.
 */
const concurrentIndexes: readonly ConcurrentIndexSpec[] = [
  {
    migrationTag: '0104_tasks_reconciling_index',
    name: 'idx_tasks_reconciling_next_retry',
    table: 'tasks',
    requiredColumns: ['kind', 'status', 'next_retry_at', 'id'],
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_reconciling_next_retry" ON "tasks" USING btree ("next_retry_at","id") WHERE "kind" = \'queue\' AND "status" = \'reconciling\'',
  },
  {
    migrationTag: '0104_tasks_reconciling_index',
    name: 'idx_tasks_reconciling_alert',
    table: 'tasks',
    requiredColumns: ['kind', 'status', 'reconcile_started_at', 'reconcile_alerted_at', 'id'],
    createSql:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_tasks_reconciling_alert" ON "tasks" USING btree ("reconcile_started_at","id") WHERE "kind" = \'queue\' AND "status" = \'reconciling\' AND "reconcile_alerted_at" IS NULL',
  },
  {
    migrationTag: '0108_media_objects_asset_image_index',
    name: 'idx_media_objects_owner_asset_image',
    table: 'media_objects',
    requiredColumns: ['user_id', 'asset_image_id'],
    createSql:
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_media_objects_owner_asset_image" ON "media_objects" USING btree ("user_id","asset_image_id") WHERE "asset_image_id" IS NOT NULL',
  },
]

// Journal idx 13 and 80 were never issued. See packages/db/README.md before adding a migration.
// Audited equivalences, not a general exemption for missing historical migrations.
// Pin both SQL bytes and journal stamps so a later edit cannot silently widen an exception.
const migrationSupersessions = [
  {
    // Both add nullable tasks.metering jsonb; the forward version tolerates its prior presence.
    original: {
      tag: '0079_task_metering',
      when: 1793000000000,
      hash: '04101eb3af9af8bb578add5e513af2a3a1cc93acb6c081b7110cd7f0fc8723c6',
    },
    forward: {
      tag: '0085_task_metering_forward',
      when: 1793600000000,
      hash: '4360feb69ca628aea548e3bea62dac0d252a81b9e9b6b982fabcf33b37edb569',
    },
  },
  {
    // Identical idempotent SQL statements; 0083 only adds an explanatory header.
    original: {
      tag: '0081_cli_device_oauth',
      when: 1793200000000,
      hash: 'f158154aa31571c0d25f59b2b0dcb9debb5999fe36adb81d0cb1df2a30c895d0',
    },
    forward: {
      tag: '0083_cli_device_oauth',
      when: 1793400000000,
      hash: '5fab338d4ba4304f9e1eef7fb719ba24cdec3b4b65fe6fbc6fbddce1b760fe16',
    },
  },
  {
    // Production applied 0092 while test already had 0093; preserve both histories.
    original: {
      tag: '0093_web_refresh_request_identity',
      when: 1794250000000,
      hash: 'd79f09af25d3d383a7572a9ec51ebf4d402bc6f196a17e1e279e243bfc6b20bb',
    },
    forward: {
      tag: '0094_web_refresh_request_identity_forward',
      when: 1794400000000,
      hash: '917a58d6295a69c998309b722040b8a5f02f27719a0f4eb734fb67be93ce12be',
    },
  },
] as const

interface MigrationHistoryRow {
  readonly hash: string
  readonly created_at: string | number
}

type Supersession = (typeof migrationSupersessions)[number]

async function verifiedSupersessionApplied(
  supersession: Supersession,
  entries: readonly { tag: string; when: number }[],
  rows: readonly MigrationHistoryRow[],
): Promise<boolean> {
  const { original, forward } = supersession
  const entry = entries.find((candidate) => candidate.tag === original.tag)
  const replacement = entries.find((candidate) => candidate.tag === forward.tag)
  if (
    entry?.when !== original.when ||
    replacement?.when !== forward.when ||
    forward.when <= original.when
  ) {
    throw new Error(`Invalid migration supersession: ${original.tag} -> ${forward.tag}`)
  }
  for (const migration of [original, forward]) {
    const sql = await Bun.file(join(migrationsFolder, `${migration.tag}.sql`)).text()
    if (createHash('sha256').update(sql).digest('hex') !== migration.hash) {
      throw new Error(`Migration supersession SQL hash mismatch: ${migration.tag}`)
    }
  }
  const recorded = rows.filter((row) => Number(row.created_at) === forward.when)
  if (recorded.some((row) => row.hash !== forward.hash)) {
    throw new Error(`Applied migration supersession hash mismatch: ${forward.tag}`)
  }
  return recorded.length > 0
}

/** Only an applied, hash-verified forward equivalent can replace a missing history row. */
export async function countVerifiedSupersededMigrations(
  rows: readonly MigrationHistoryRow[],
): Promise<number> {
  const applied = new Set(rows.map((row) => Number(row.created_at)))
  const journal: { entries: { tag: string; when: number }[] } = await Bun.file(
    join(migrationsFolder, 'meta/_journal.json'),
  ).json()
  let count = 0
  for (const supersession of migrationSupersessions) {
    if (
      !applied.has(supersession.original.when) &&
      (await verifiedSupersessionApplied(supersession, journal.entries, rows))
    ) {
      count++
    }
  }
  return count
}

export interface RunMigrationsOptions {
  /** Optional observer invoked after each hot-table index is built via `CREATE INDEX CONCURRENTLY`. */
  readonly onConcurrentIndexBuilt?: (indexName: string) => void
}

interface MigrationJournal {
  readonly version: string
  readonly dialect: string
  readonly entries: readonly {
    idx: number
    version: string
    when: number
    tag: string
    breakpoints: boolean
  }[]
}

async function readMigrationJournal(): Promise<MigrationJournal> {
  return Bun.file(join(migrationsFolder, 'meta/_journal.json')).json()
}

async function migratePrefix(
  client: SQL,
  journal: MigrationJournal,
  endExclusive: number,
): Promise<void> {
  const entries = journal.entries.slice(0, endExclusive)
  const dir = await mkdtemp(join(tmpdir(), 'aip-migrate-stage-'))
  try {
    await mkdir(join(dir, 'meta'))
    await Bun.write(
      join(dir, 'meta/_journal.json'),
      JSON.stringify({ version: journal.version, dialect: journal.dialect, entries }),
    )
    for (const entry of entries) {
      await symlink(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`))
    }
    await migrate(drizzle(client), { migrationsFolder: dir })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Apply committed PostgreSQL migrations and release the migration connection. */
export async function runMigrations(
  databaseUrl: string,
  options?: RunMigrationsOptions,
): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 })
  let locked = false
  try {
    await client`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK}))`
    locked = true
    await assertNoSkippedMigrations(client)
    await applyPendingConcurrentIndexStages(client, options)
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    if (locked) await client`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK}))`
    await client.close()
  }
}

/**
 * On an existing database, stages prerequisite migrations before each pending concurrent-index
 * migration so required columns commit first, then builds the hot-table indexes outside any
 * transaction with `CREATE INDEX CONCURRENTLY` before Drizzle records the index migration.
 */
async function applyPendingConcurrentIndexStages(
  client: SQL,
  options?: RunMigrationsOptions,
): Promise<void> {
  if (!concurrentIndexes.length) return
  const [table] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`
  if (!table?.name) return
  const rows: { created_at: string | number }[] =
    await client`SELECT created_at FROM drizzle.__drizzle_migrations`
  if (!rows.length) return
  const applied = new Set(rows.map((row) => Number(row.created_at)))
  const newestApplied = Math.max(...applied)
  const journal = await readMigrationJournal()

  const pendingTags = [...new Set(concurrentIndexes.map((spec) => spec.migrationTag))]
    .map((tag) => {
      const index = journal.entries.findIndex((entry) => entry.tag === tag)
      if (index < 0) {
        throw new Error(`Concurrent index references unknown migration tag: ${tag}`)
      }
      return { tag, index, entry: journal.entries[index]! }
    })
    .filter(({ entry }) => !applied.has(entry.when))
    .sort((a, b) => a.index - b.index)

  let currentNewest = newestApplied
  for (const { tag, index } of pendingTags) {
    // Commit prerequisite migrations strictly before `tag` when any exist so columns added by
    // earlier migrations (e.g. 0073 before 0104) are visible to `CREATE INDEX CONCURRENTLY`.
    const previous = index > 0 ? journal.entries[index - 1] : undefined
    if (previous && previous.when > currentNewest) {
      await migratePrefix(client, journal, index)
      currentNewest = previous.when
    }
    await ensureConcurrentIndexes(client, { migrationTag: tag, ...options })
  }
}

/**
 * Pre-builds pending hot-table indexes outside any transaction using `CREATE INDEX CONCURRENTLY`,
 * cleaning up any invalid index left behind by an earlier interrupted build before retrying.
 */
export async function ensureConcurrentIndexes(
  client: SQL,
  options?: RunMigrationsOptions & { readonly migrationTag?: string },
): Promise<void> {
  const specs = options?.migrationTag
    ? concurrentIndexes.filter((spec) => spec.migrationTag === options.migrationTag)
    : concurrentIndexes
  if (!specs.length) return
  const [table] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`
  if (!table?.name) return
  const rows: { created_at: string | number }[] =
    await client`SELECT created_at FROM drizzle.__drizzle_migrations`
  if (!rows.length) return
  const applied = new Set(rows.map((row) => Number(row.created_at)))
  const journal = await readMigrationJournal()
  const stampByTag = new Map(journal.entries.map((entry) => [entry.tag, entry.when]))

  for (const spec of specs) {
    const when = stampByTag.get(spec.migrationTag)
    if (when === undefined) {
      throw new Error(`Concurrent index references unknown migration tag: ${spec.migrationTag}`)
    }
    if (applied.has(when)) continue

    const columnRows: { column_name: string }[] = await client`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${spec.table}
    `
    const existingColumns = new Set(columnRows.map((row) => row.column_name))
    const missingColumns = spec.requiredColumns.filter((column) => !existingColumns.has(column))
    if (missingColumns.length) {
      throw new Error(
        `Cannot concurrently build ${spec.name} before ${spec.migrationTag}: missing ${spec.table} column(s) ${missingColumns.join(', ')}`,
      )
    }

    const [existing] = await client<{ indisvalid: boolean }[]>`
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = ${spec.name}
    `
    if (existing?.indisvalid) continue
    if (existing && !existing.indisvalid) {
      await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${spec.name}"`)
    }
    await client.unsafe(spec.createSql)
    const [verified] = await client<{ indisvalid: boolean }[]>`
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'public' AND c.relname = ${spec.name}
    `
    if (!verified?.indisvalid) {
      throw new Error(`Concurrent index ${spec.name} is invalid after creation`)
    }
    options?.onConcurrentIndexBuilt?.(spec.name)
  }
}

/**
 * drizzle only compares timestamps: it applies a journal entry when its `when` is newer than the
 * newest applied `created_at`, and silently skips anything older. A migration merged after a
 * newer-stamped one (two PRs landing out of order) would therefore never run. Refuse unless an
 * audited equivalent is already applied or will run in drizzle's migration transaction. Never
 * insert synthetic historical rows: a failed forward migration must leave history untouched.
 */
async function assertNoSkippedMigrations(client: SQL): Promise<void> {
  const [table] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`
  if (!table?.name) return
  const rows: { hash: string; created_at: string | number }[] =
    await client`SELECT hash, created_at FROM drizzle.__drizzle_migrations`
  if (!rows.length) return
  const applied = new Set(rows.map((row) => Number(row.created_at)))
  const newest = Math.max(...applied)
  const journal: { entries: { tag: string; when: number }[] } = await Bun.file(
    join(migrationsFolder, 'meta/_journal.json'),
  ).json()
  const skipped: string[] = []
  for (const entry of journal.entries) {
    if (entry.when > newest || applied.has(entry.when)) continue
    const supersession = migrationSupersessions.find(({ original }) => original.tag === entry.tag)
    if (supersession) {
      const appliedForward = await verifiedSupersessionApplied(supersession, journal.entries, rows)
      // Future SQL and its history row commit together in migrate(); an older missing
      // replacement is not runnable and must still fail the ordinary skipped-entry guard.
      if (appliedForward || supersession.forward.when > newest) continue
    }
    skipped.push(entry.tag)
  }
  if (skipped.length)
    throw new Error(
      `Migrations ${skipped.join(', ')} are older than the newest applied one (${newest}) and would be skipped. ` +
        'Check the schema, apply each listed .sql by hand, then record it in drizzle.__drizzle_migrations ' +
        '(its sha256 hash and journal `when` as created_at) so the release can continue.',
    )
}
