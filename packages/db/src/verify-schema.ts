import { SQL } from 'bun'

export const EXPECTED_TABLES = [
  'daily_quota',
  'operator_audits',
  'tasks',
  'user_identities',
  'user_sessions',
  'users',
] as const

export const EXPECTED_INDEXES = [
  'daily_quota_device_id_date_pk',
  'idx_operator_audits_created_at',
  'idx_operator_audits_target',
  'idx_tasks_admin_device_time',
  'idx_tasks_anonymous_client_request_id',
  'idx_tasks_next_retry_at',
  'idx_tasks_status',
  'idx_tasks_submitted_at',
  'idx_tasks_user_client_request_id',
  'idx_tasks_user_time',
  'idx_user_identities_provider_subject',
  'idx_user_identities_user_id',
  'idx_user_sessions_expires_at',
  'idx_user_sessions_user_id',
  'idx_users_username',
  'operator_audits_pkey',
  'tasks_pkey',
  'user_identities_pkey',
  'user_sessions_pkey',
  'users_pkey',
] as const

const EXPECTED_MIGRATION_COUNT = 7

export interface SchemaVerificationResult {
  tables: number
  indexes: number
  migrations: number
}

export async function verifySchema(databaseUrl: string): Promise<SchemaVerificationResult> {
  const client = new SQL(databaseUrl, { max: 1 })
  try {
    const [tableRows, indexRows, migrationTableRows] = await Promise.all([
      client<{ tablename: string }[]>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
      `,
      client<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
      `,
      client<{ relation: string | null }[]>`
        SELECT to_regclass('drizzle.__drizzle_migrations')::text AS relation
      `,
    ])
    const migrationRows = migrationTableRows[0]?.relation
      ? await client<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM drizzle.__drizzle_migrations
        `
      : []
    const tables = new Set(tableRows.map((row) => row.tablename))
    const indexes = new Set(indexRows.map((row) => row.indexname))
    const missingTables = EXPECTED_TABLES.filter((name) => !tables.has(name))
    const missingIndexes = EXPECTED_INDEXES.filter((name) => !indexes.has(name))
    const migrationCount = Number(migrationRows[0]?.count ?? 0)
    const failures = [
      missingTables.length ? `missing tables: ${missingTables.join(', ')}` : '',
      missingIndexes.length ? `missing indexes: ${missingIndexes.join(', ')}` : '',
      migrationCount < EXPECTED_MIGRATION_COUNT
        ? `migration count ${migrationCount} is below ${EXPECTED_MIGRATION_COUNT}`
        : '',
    ].filter(Boolean)
    if (failures.length) throw new Error(`Schema verification failed: ${failures.join('; ')}`)
    return {
      tables: EXPECTED_TABLES.length,
      indexes: EXPECTED_INDEXES.length,
      migrations: migrationCount,
    }
  } finally {
    await client.close()
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const result = await verifySchema(databaseUrl)
  console.log(
    `Schema verified: ${result.tables} tables, ${result.indexes} indexes, ${result.migrations} migrations`,
  )
}
