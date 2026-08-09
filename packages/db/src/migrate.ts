import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import { migrate } from 'drizzle-orm/bun-sql/migrator'

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/** Apply committed PostgreSQL migrations and release the migration connection. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = new SQL(databaseUrl, { max: 1 })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.close()
  }
}
