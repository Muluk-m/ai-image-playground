import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))
const MIGRATION_LOCK = 'ai-image-playground:migrations'

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
 * newer-stamped one (two PRs landing out of order) would therefore never run. Refuse to migrate
 * instead, naming the entries, so the release stops before the schema drifts.
 */
async function assertNoSkippedMigrations(client: SQL): Promise<void> {
  const [table] = await client`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`
  if (!table?.name) return
  const rows: { created_at: string | number }[] =
    await client`SELECT created_at FROM drizzle.__drizzle_migrations`
  if (!rows.length) return
  const applied = new Set(rows.map((row) => Number(row.created_at)))
  const newest = Math.max(...applied)
  const journal: { entries: { tag: string; when: number }[] } = await Bun.file(
    join(migrationsFolder, 'meta/_journal.json'),
  ).json()
  const skipped = journal.entries
    .filter((entry) => entry.when <= newest && !applied.has(entry.when))
    .map((entry) => entry.tag)
  if (skipped.length)
    throw new Error(
      `Migrations ${skipped.join(', ')} are older than the newest applied one (${newest}) and would be skipped. ` +
        'Check the schema, apply each listed .sql by hand, then record it in drizzle.__drizzle_migrations ' +
        '(its sha256 hash and journal `when` as created_at) so the release can continue.',
    )
}
