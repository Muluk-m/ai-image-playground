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
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    if (locked) await client`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK}))`
    await client.close()
  }
}
