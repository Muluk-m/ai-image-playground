import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { SQL } from 'bun'
import { runMigrations } from './migrate'

const DATABASE_NAME_PATTERN = /^[a-z0-9_]+$/
/** PostgreSQL silently truncates longer identifiers, so two long suite names could collide. */
const MAX_DATABASE_NAME_BYTES = 63
const TEMPLATE_LOCK = 'ai-image-playground:test-template'
const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url))

/**
 * The suite that already claimed this process. A second suite would silently read the first one's
 * data: DATABASE_URL, the operator config and the Elysia app are module singletons, so whichever
 * file imports them first pins every later file to its database.
 */
let claimedSuite: string | null = null

/**
 * Recreates an isolated PostgreSQL database for one test file with all migrations applied.
 * TEST_DATABASE_URL must point at a disposable local database whose name contains "test".
 *
 * The migrations run once per migration set into a template database; every suite then clones
 * it, which is much cheaper than replaying every migration per file. Clones are serialized by an
 * advisory lock, so suites in parallel processes are safe.
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
  const databaseName = checkedDatabaseName(`${baseName}_${suffix}`)
  const templatePrefix = `${baseName}_tpl_`
  const templateName = checkedDatabaseName(`${templatePrefix}${await migrationsFingerprint()}`)

  const databaseUrl = new URL(base)
  databaseUrl.pathname = `/${databaseName}`
  const adminUrl = new URL(base)
  adminUrl.pathname = '/postgres'

  const admin = new SQL(adminUrl.toString(), { max: 1 })
  let locked = false
  try {
    await admin`SELECT pg_advisory_lock(hashtext(${TEMPLATE_LOCK}))`
    locked = true
    await ensureTemplate(admin, base, templateName, templatePrefix)
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.unsafe(`CREATE DATABASE "${databaseName}" TEMPLATE "${templateName}"`)
  } finally {
    if (locked) await admin`SELECT pg_advisory_unlock(hashtext(${TEMPLATE_LOCK}))`
    await admin.close()
  }

  return databaseUrl.toString()
}

function checkedDatabaseName(name: string): string {
  if (!DATABASE_NAME_PATTERN.test(name)) throw new Error(`invalid test database name: ${name}`)
  if (Buffer.byteLength(name) > MAX_DATABASE_NAME_BYTES) {
    throw new Error(`test database name exceeds ${MAX_DATABASE_NAME_BYTES} bytes: ${name}`)
  }
  return name
}

/** Changes whenever a committed migration or the journal changes, so a stale template is never reused. */
async function migrationsFingerprint(): Promise<string> {
  const files = await Array.fromAsync(
    new Bun.Glob('{*.sql,meta/_journal.json}').scan({ cwd: migrationsFolder }),
  )
  const hash = createHash('sha256')
  for (const file of files.sort()) {
    hash.update(file)
    hash.update(await Bun.file(`${migrationsFolder}/${file}`).bytes())
  }
  return hash.digest('hex').slice(0, 12)
}

/** Builds the template under the caller's lock; replaces templates left by older migration sets. */
async function ensureTemplate(
  admin: SQL,
  base: URL,
  templateName: string,
  templatePrefix: string,
): Promise<void> {
  const existing: { datname: string }[] = await admin`
    SELECT datname FROM pg_database WHERE starts_with(datname, ${templatePrefix})
  `
  if (existing.some((row) => row.datname === templateName)) return

  for (const { datname } of existing) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`)
  }
  // Migrate under a scratch name and rename at the end: a run killed mid-migration must not
  // leave a half-built database behind the template's name.
  const buildingName = checkedDatabaseName(`${templateName}_b`)
  await admin.unsafe(`DROP DATABASE IF EXISTS "${buildingName}" WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE "${buildingName}"`)
  const buildingUrl = new URL(base)
  buildingUrl.pathname = `/${buildingName}`
  await runMigrations(buildingUrl.toString())
  await admin.unsafe(`ALTER DATABASE "${buildingName}" RENAME TO "${templateName}"`)
}
