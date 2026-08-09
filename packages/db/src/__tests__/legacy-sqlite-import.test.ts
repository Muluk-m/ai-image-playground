import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from '../client'
import { importLegacySqlite } from '../legacy-sqlite-import'
import { resetTestDatabase } from '../testing'

const databaseUrl = await resetTestDatabase('legacy_sqlite_import')
const sqlitePath = join(tmpdir(), `image-playground-legacy-${crypto.randomUUID()}.sqlite`)

function createLegacyDatabase(): void {
  const db = new Database(sqlitePath, { create: true })
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE user_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      result_payload TEXT,
      error_message TEXT,
      error_type TEXT,
      submitted_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      next_retry_at INTEGER,
      attempt_count INTEGER NOT NULL,
      user_id TEXT,
      client_request_id TEXT
    );
    CREATE TABLE daily_quota (
      device_id TEXT NOT NULL,
      date TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (device_id, date)
    );
  `)
  const timestamp = Date.UTC(2026, 7, 9, 8, 30)
  db.query('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'user-1',
    'alice',
    'argon-hash',
    'active',
    timestamp,
    timestamp + 1_000,
    timestamp + 2_000,
  )
  db.query('INSERT INTO user_sessions VALUES (?, ?, ?, ?)').run(
    'token-hash',
    'user-1',
    timestamp,
    timestamp + 86_400_000,
  )
  db.query('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'task-1',
    'openai-compat',
    'gpt-image-2',
    'completed',
    JSON.stringify({
      prompt: 'legacy',
      device_id: 'device-1',
      input_images: ['data:image/png;base64,abc'],
    }),
    JSON.stringify({ data: [{ b64_json: 'legacy-output' }] }),
    null,
    null,
    timestamp,
    timestamp + 100,
    timestamp + 200,
    null,
    1,
    'user-1',
    'request-1',
  )
  db.query('INSERT INTO daily_quota VALUES (?, ?, ?)').run('device-1', '2026-08-09', 7)
  db.close()
}

afterAll(() => {
  try {
    unlinkSync(sqlitePath)
  } catch {}
})

describe('importLegacySqlite', () => {
  it('copies relational data and JSON payloads into an empty PostgreSQL database', async () => {
    createLegacyDatabase()

    await expect(importLegacySqlite(sqlitePath, databaseUrl)).resolves.toEqual({
      users: 1,
      sessions: 1,
      tasks: 1,
      dailyQuota: 1,
    })

    const target = createDb(databaseUrl)
    const [task] = await target.client`
      SELECT request_payload, result_payload, submitted_at, device_id
      FROM tasks
      WHERE id = 'task-1'
    `
    expect(task).toMatchObject({
      request_payload: {
        prompt: 'legacy',
        device_id: 'device-1',
        input_images: ['data:image/png;base64,abc'],
      },
      result_payload: { data: [{ b64_json: 'legacy-output' }] },
      device_id: 'device-1',
    })
    const submittedAt = task?.submitted_at
    if (!(submittedAt instanceof Date))
      throw new Error('PostgreSQL must return submitted_at as a Date')
    expect(submittedAt.getTime()).toBe(Date.UTC(2026, 7, 9, 8, 30))
    await target.close()
  })

  it('rejects a non-empty PostgreSQL target instead of duplicating data', async () => {
    await expect(importLegacySqlite(sqlitePath, databaseUrl)).rejects.toThrow(
      'PostgreSQL import target must be empty',
    )
  })
})
