import { runMigrations as runPublicMigrations } from '@image-playground/db'
import { config } from '../config'

type PrivateMigrationModule = {
  runPrivateMigrations(databaseUrl: string): Promise<void>
}

const privateMigrationEntry = new URL('../../../../private/apps/bff/migrate.ts', import.meta.url)

export async function runMigrations(databaseUrl: string = config.databaseUrl): Promise<void> {
  await runPublicMigrations(databaseUrl)
  if (!(await Bun.file(privateMigrationEntry).exists())) return

  const privateModule: Partial<PrivateMigrationModule> = await import(privateMigrationEntry.href)
  if (typeof privateModule.runPrivateMigrations !== 'function') {
    throw new Error('private/apps/bff/migrate.ts must export runPrivateMigrations')
  }
  await privateModule.runPrivateMigrations(databaseUrl)
}

if (import.meta.main) {
  await runMigrations()
  console.log('✓ PostgreSQL migrations applied')
}
