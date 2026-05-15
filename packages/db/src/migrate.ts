import { Database } from 'bun:sqlite'

/**
 * 直接执行建表 DDL，不依赖 drizzle-kit migrate runtime（避免 bun:sqlite 跟
 * better-sqlite3 migration runner 兼容性折腾）。schema 变更时用 drizzle-kit
 * generate 看 SQL 后手工同步到这里。
 */
// 只放「不依赖新列」的 DDL；新列与对应索引在下面通过 ALTER + 列存在检查后再建，
// 避免老库走到「CREATE TABLE IF NOT EXISTS 跳过 → UNIQUE INDEX 引用不存在的列」
// 的失败路径。
const DDL_BASE = `
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

  CREATE TABLE IF NOT EXISTS daily_quota (
    device_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, date)
  );
`

export function runMigrations(databaseUrl: string) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec(DDL_BASE)
  // 老库兼容：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列。
  const cols = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'client_request_id')) {
    sqlite.exec(`ALTER TABLE tasks ADD COLUMN client_request_id TEXT;`)
  }
  // partial unique 索引：NULL 不去重，老任务/未带 ID 的请求各自独立。
  // 列确保存在后再建，避免对老库报 "no such column"。
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id
               ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;`)
  sqlite.close()
}
