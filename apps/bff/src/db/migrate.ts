import { runMigrations as runPublicMigrations } from '@image-playground/db'
import { isCapabilityEnabled } from '../lib/capabilities'
import { runPrivateMigrations } from '../lib/private-overlay'
import { resolveDirectDatabaseUrl } from './client'

export async function runMigrations(
  databaseUrl: string = resolveDirectDatabaseUrl(),
): Promise<void> {
  await runPublicMigrations(databaseUrl)
  if (isCapabilityEnabled('billing:credits')) await runPrivateMigrations(databaseUrl)
}

if (import.meta.main) {
  await runMigrations()
  console.log('✓ PostgreSQL migrations applied')
}
