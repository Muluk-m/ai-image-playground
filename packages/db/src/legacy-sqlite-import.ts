import { Database } from 'bun:sqlite'
import type { SQL } from 'bun'
import { createDb } from './client'
import { runMigrations } from './migrate'

type LegacyRow = Record<string, unknown>

export interface LegacyImportCounts {
  users: number
  sessions: number
  tasks: number
  dailyQuota: number
}

function requiredString(row: LegacyRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') throw new Error(`Legacy row field ${field} must be a string`)
  return value
}

function nullableString(row: LegacyRow, field: string): string | null {
  const value = row[field]
  if (value === null) return null
  if (typeof value !== 'string')
    throw new Error(`Legacy row field ${field} must be a string or null`)
  return value
}

function requiredNumber(row: LegacyRow, field: string): number {
  const value = row[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Legacy row field ${field} must be a finite number`)
  }
  return value
}

function nullableNumber(row: LegacyRow, field: string): number | null {
  const value = row[field]
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Legacy row field ${field} must be a finite number or null`)
  }
  return value
}

function jsonObject(row: LegacyRow, field: string): Record<string, unknown> {
  const value = JSON.parse(requiredString(row, field))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Legacy row field ${field} must contain a JSON object`)
  }
  return value
}

function nullableJsonObject(row: LegacyRow, field: string): Record<string, unknown> | null {
  const raw = nullableString(row, field)
  if (raw === null) return null
  const value = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Legacy row field ${field} must contain a JSON object or null`)
  }
  return value
}

function rows(database: Database, statement: string): IterableIterator<LegacyRow> {
  return database.query<LegacyRow, []>(statement).iterate()
}

async function assertEmptyTarget(client: SQL): Promise<void> {
  const result = await client`
    SELECT
      (SELECT COUNT(*) FROM users) +
      (SELECT COUNT(*) FROM user_sessions) +
      (SELECT COUNT(*) FROM tasks) +
      (SELECT COUNT(*) FROM daily_quota) AS row_count
  `
  if (Number(result[0]?.row_count ?? 0) !== 0) {
    throw new Error('PostgreSQL import target must be empty')
  }
}

export async function importLegacySqlite(
  sqlitePath: string,
  databaseUrl: string,
): Promise<LegacyImportCounts> {
  const source = new Database(sqlitePath, { readonly: true, strict: true })
  const target = createDb(databaseUrl)
  const counts: LegacyImportCounts = { users: 0, sessions: 0, tasks: 0, dailyQuota: 0 }

  try {
    await runMigrations(databaseUrl)
    await assertEmptyTarget(target.client)

    await target.client.begin(async (sql) => {
      for (const row of rows(
        source,
        'SELECT id, username, password_hash, status, created_at, updated_at, last_login_at FROM users ORDER BY created_at, id',
      )) {
        const lastLoginAt = nullableNumber(row, 'last_login_at')
        await sql`
          INSERT INTO users (id, username, password_hash, status, created_at, updated_at, last_login_at)
          VALUES (
            ${requiredString(row, 'id')},
            ${requiredString(row, 'username')},
            ${requiredString(row, 'password_hash')},
            ${requiredString(row, 'status')},
            ${new Date(requiredNumber(row, 'created_at'))},
            ${new Date(requiredNumber(row, 'updated_at'))},
            ${lastLoginAt === null ? null : new Date(lastLoginAt)}
          )
        `
        counts.users += 1
      }

      for (const row of rows(
        source,
        'SELECT token_hash, user_id, created_at, expires_at FROM user_sessions ORDER BY created_at, token_hash',
      )) {
        await sql`
          INSERT INTO user_sessions (token_hash, user_id, created_at, expires_at)
          VALUES (
            ${requiredString(row, 'token_hash')},
            ${requiredString(row, 'user_id')},
            ${new Date(requiredNumber(row, 'created_at'))},
            ${new Date(requiredNumber(row, 'expires_at'))}
          )
        `
        counts.sessions += 1
      }

      for (const row of rows(
        source,
        `SELECT id, provider, model, status, request_payload, result_payload, error_message,
          error_type, submitted_at, started_at, completed_at, next_retry_at, attempt_count,
          user_id, client_request_id FROM tasks ORDER BY submitted_at, id`,
      )) {
        const startedAt = nullableNumber(row, 'started_at')
        const completedAt = nullableNumber(row, 'completed_at')
        const nextRetryAt = nullableNumber(row, 'next_retry_at')
        await sql`
          INSERT INTO tasks (
            id, provider, model, status, request_payload, result_payload, error_message,
            error_type, submitted_at, started_at, completed_at, next_retry_at, attempt_count,
            user_id, client_request_id
          ) VALUES (
            ${requiredString(row, 'id')},
            ${requiredString(row, 'provider')},
            ${requiredString(row, 'model')},
            ${requiredString(row, 'status')},
            ${jsonObject(row, 'request_payload')},
            ${nullableJsonObject(row, 'result_payload')},
            ${nullableString(row, 'error_message')},
            ${nullableString(row, 'error_type')},
            ${new Date(requiredNumber(row, 'submitted_at'))},
            ${startedAt === null ? null : new Date(startedAt)},
            ${completedAt === null ? null : new Date(completedAt)},
            ${nextRetryAt === null ? null : new Date(nextRetryAt)},
            ${requiredNumber(row, 'attempt_count')},
            ${nullableString(row, 'user_id')},
            ${nullableString(row, 'client_request_id')}
          )
        `
        counts.tasks += 1
      }

      for (const row of rows(
        source,
        'SELECT device_id, date, count FROM daily_quota ORDER BY date, device_id',
      )) {
        await sql`
          INSERT INTO daily_quota (device_id, date, count)
          VALUES (
            ${requiredString(row, 'device_id')},
            ${requiredString(row, 'date')},
            ${requiredNumber(row, 'count')}
          )
        `
        counts.dailyQuota += 1
      }
    })

    return counts
  } finally {
    source.close()
    await target.close()
  }
}
