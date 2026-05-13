import { Database } from 'bun:sqlite'
import { config } from '../config'

/**
 * 直接执行建表 DDL，不依赖 drizzle-kit migrate runtime（避免 bun:sqlite 跟
 * better-sqlite3 migration runner 兼容性折腾）。schema 变更时用 drizzle-kit
 * generate 看 SQL 后手工同步到这里。
 */
const DDL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    status             TEXT NOT NULL,
    request_payload    TEXT NOT NULL,
    result_payload     TEXT,
    error_message      TEXT,
    error_type         TEXT,
    submitted_at       INTEGER NOT NULL,
    started_at         INTEGER,
    completed_at       INTEGER,
    client_request_id  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at ON tasks(submitted_at);
  -- partial unique 索引：NULL 不去重，老任务/未带 ID 的请求各自独立。
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id
    ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;
`

export function runMigrations(databaseUrl: string = config.databaseUrl) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec(DDL)
  // 老库兼容：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列。
  const cols = sqlite.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'client_request_id')) {
    sqlite.exec(`ALTER TABLE tasks ADD COLUMN client_request_id TEXT;`)
    sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id
                 ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;`)
  }
  sqlite.close()
}

if (import.meta.main) {
  runMigrations()
  console.log(`✓ migrations applied to ${config.databaseUrl}`)
}
