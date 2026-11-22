import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const billingMigrationsFolder = fileURLToPath(new URL('../drizzle-billing', import.meta.url))
const MIGRATION_LOCK = 'ai-image-playground:migrations'
const migrationPromises = new Map<string, Promise<void>>()

/**
 * Apply committed billing migrations into the existing `private_billing.migrations` tracking table
 * so production and test databases continue seamlessly without replaying history.
 */
export function ensureBillingMigrations(databaseUrl: string): Promise<void> {
  const existing = migrationPromises.get(databaseUrl)
  if (existing) return existing
  const migrationPromise = (async () => {
    if (!databaseUrl.trim()) throw new Error('databaseUrl is required for billing migrations')
    const client = new SQL(databaseUrl, { max: 1 })
    let locked = false
    try {
      await client`SELECT pg_advisory_lock(hashtext(${MIGRATION_LOCK}))`
      locked = true
      await migrate(drizzle(client), {
        migrationsFolder: billingMigrationsFolder,
        migrationsSchema: 'private_billing',
        migrationsTable: 'migrations',
      })
    } finally {
      if (locked) await client`SELECT pg_advisory_unlock(hashtext(${MIGRATION_LOCK}))`
      await client.close()
    }
  })().catch((error) => {
    migrationPromises.delete(databaseUrl)
    throw error
  })
  migrationPromises.set(databaseUrl, migrationPromise)
  return migrationPromise
}
