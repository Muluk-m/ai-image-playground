import { Database } from 'bun:sqlite'
import { config } from '../config'

/**
 * 直接执行建表 DDL，不依赖 drizzle-kit migrate runtime（避免 bun:sqlite 跟
 * better-sqlite3 migration runner 兼容性折腾）。schema 变更时用 drizzle-kit
 * generate 看 SQL 后手工同步到这里。
 */
const DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY,
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    status          TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    result_payload  TEXT,
    error_message   TEXT,
    error_type      TEXT,
    submitted_at    INTEGER NOT NULL,
    started_at      INTEGER,
    completed_at    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at ON tasks(submitted_at);
`

export function runMigrations(databaseUrl: string = config.databaseUrl) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec(DDL)
  sqlite.close()
}

if (import.meta.main) {
  runMigrations()
  console.log(`✓ migrations applied to ${config.databaseUrl}`)
}
