import { SQL } from 'bun'
import { runMigrations } from './migrate'

const DATABASE_NAME_PATTERN = /^[a-z0-9_]+$/

/**
 * The suite that already claimed this process. A second suite would silently read the first one's
 * data: DATABASE_URL, the operator config and the Elysia app are module singletons, so whichever
 * file imports them first pins every later file to its database.
 */
let claimedSuite: string | null = null

/**
 * Recreates an isolated PostgreSQL database for one test file, then applies all migrations.
 * TEST_DATABASE_URL must point at a disposable local database whose name contains "test".
 *
 * One process serves one suite. Run database-backed test files through
 * `scripts/run-bun-tests-isolated.ts` (every package's `pnpm test`), which spawns a process per
 * file, rather than through a bare `bun test <filter>` that loads several of them at once.
 */
export async function resetTestDatabase(suite: string): Promise<string> {
  if (claimedSuite !== null && claimedSuite !== suite) {
    throw new Error(
      `Suite "${claimedSuite}" already claimed this Bun process, so "${suite}" cannot reset its own database here. ` +
        'Database-backed suites pin module singletons (DATABASE_URL, operator config, the Elysia app) to the first ' +
        'database they see. Run `pnpm test` in the package, which gives every test file its own process.',
    )
  }
  claimedSuite = suite

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
