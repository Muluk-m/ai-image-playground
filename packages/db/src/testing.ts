import { SQL } from 'bun'
import { runMigrations } from './migrate'

const DATABASE_NAME_PATTERN = /^[a-z0-9_]+$/

/**
 * Recreates an isolated PostgreSQL database for one test file, then applies all migrations.
 * TEST_DATABASE_URL must point at a disposable local database whose name contains "test".
 */
export async function resetTestDatabase(suite: string): Promise<string> {
  const configured = process.env.TEST_DATABASE_URL?.trim()
  if (!configured) throw new Error('TEST_DATABASE_URL is required for PostgreSQL tests')

  const base = new URL(configured)
  const host = base.hostname
  const baseName = base.pathname.slice(1)
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !baseName.includes('test')) {
    throw new Error('TEST_DATABASE_URL must target a disposable local test database')
  }

  const suffix = suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
  const databaseName = `${baseName}_${suffix}`
  if (!DATABASE_NAME_PATTERN.test(databaseName)) throw new Error('invalid test database name')

  const databaseUrl = new URL(base)
  databaseUrl.pathname = `/${databaseName}`
  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'

  const admin = new SQL(adminUrl.toString(), { max: 1 })
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await admin.close()
  }

  await runMigrations(databaseUrl.toString())
  return databaseUrl.toString()
}
