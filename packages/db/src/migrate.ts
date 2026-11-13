import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const MIGRATION_LOCK = 'ai-image-playground:migrations'

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

/** Apply committed PostgreSQL migrations and release the migration connection. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 })
  let locked = false
  try {
    await client`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK}))`
    locked = true
    await assertNoSkippedMigrations(client)
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    if (locked) await client`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK}))`
    await client.close()
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
