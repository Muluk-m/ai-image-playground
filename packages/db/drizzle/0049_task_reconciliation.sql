ALTER TABLE tasks ADD COLUMN reconciliation_required boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_reconciling_check CHECK (status <> 'reconciling' OR reconciliation_required);
--> statement-breakpoint
CREATE TABLE task_dispatches (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  execution_token text NOT NULL,
  intended_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  upstream_request_id text,
  upstream_task_id text
);
--> statement-breakpoint
CREATE INDEX idx_task_dispatches_task ON task_dispatches(task_id, intended_at);
