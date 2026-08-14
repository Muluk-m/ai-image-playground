import { runMigrations as runMigrationsBase } from '@image-playground/db'
import { config } from '../config'

export function runMigrations(databaseUrl: string = config.databaseUrl) {
  return runMigrationsBase(databaseUrl)
}

if (import.meta.main) {
  runMigrations()
  console.log(`✓ migrations applied to ${config.databaseUrl}`)
}
