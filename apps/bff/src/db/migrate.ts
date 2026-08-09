import { runMigrations as runPublicMigrations } from '@image-playground/db'
import { config } from '../config'
import { runPrivateMigrations } from '../lib/private-overlay'

export async function runMigrations(databaseUrl: string = config.databaseUrl): Promise<void> {
  await runPublicMigrations(databaseUrl)
  await runPrivateMigrations(databaseUrl)
}

if (import.meta.main) {
  await runMigrations()
  console.log('✓ PostgreSQL migrations applied')
}
