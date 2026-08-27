const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  provider           TEXT NOT NULL,
  model              TEXT NOT NULL,
  status             TEXT NOT NULL,
  request_payload    JSONB NOT NULL,
  result_payload     JSONB,
  error_message      TEXT,
  error_type         TEXT,
  upstream_status    INTEGER,
  upstream_body      TEXT,
  submitted_at       BIGINT NOT NULL,
  started_at         BIGINT,
  completed_at       BIGINT,
  client_request_id  TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_retry_at      BIGINT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at ON tasks(submitted_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id
  ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_next_retry_at
  ON tasks(next_retry_at) WHERE next_retry_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_blobs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  data       BYTEA NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(task_id, kind, idx)
);

CREATE TABLE IF NOT EXISTS daily_quota (
  device_id TEXT NOT NULL,
  date      TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, date)
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS device_id TEXT
  GENERATED ALWAYS AS (request_payload->>'device_id') STORED;

CREATE INDEX IF NOT EXISTS idx_tasks_admin_device_time
  ON tasks(device_id, submitted_at DESC, id DESC, status, model);
`

export async function runPgMigrations(exec: (sql: string) => Promise<unknown>): Promise<void> {
  await exec('SELECT pg_advisory_lock(872314)')
  try {
    await exec(DDL)
  } finally {
    await exec('SELECT pg_advisory_unlock(872314)')
  }
}
