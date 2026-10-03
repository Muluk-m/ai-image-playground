ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
--> statement-breakpoint
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('queue', 'chat', 'analysis'));
--> statement-breakpoint

-- Durable analysis ownership/result/accounting snapshot, independent of chat and task cleanup.
CREATE TABLE analysis_tasks (
  task_id text PRIMARY KEY,
  user_id text NOT NULL,
  device_id text NOT NULL,
  batch_id text NOT NULL,
  plan_version integer NOT NULL,
  item_key text NOT NULL,
  attempt integer NOT NULL CONSTRAINT analysis_tasks_attempt_check CHECK (attempt > 0),
  origin_conversation_id text,
  origin_turn_id text NOT NULL,
  model text NOT NULL,
  input_snapshot jsonb NOT NULL,
  price_snapshot jsonb NOT NULL,
  reserved_credits integer NOT NULL CONSTRAINT analysis_tasks_reserved_check CHECK (reserved_credits >= 0),
  actual_credits integer,
  status text NOT NULL CONSTRAINT analysis_tasks_status_check CHECK (status IN ('queued', 'in_progress', 'reconciling', 'completed', 'failed', 'cancelled')),
  findings jsonb,
  coverage jsonb,
  evidence jsonb,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CONSTRAINT idx_analysis_tasks_item_attempt UNIQUE (batch_id, item_key, attempt)
);
--> statement-breakpoint
CREATE INDEX idx_analysis_tasks_owner_created ON analysis_tasks(user_id, created_at DESC, task_id);
--> statement-breakpoint

-- A paid item has exactly one logical model call; a new paid try must use a new task/attempt.
-- This row may accept a late response from its original executor as evidence only.
CREATE TABLE analysis_model_calls (
  id text PRIMARY KEY,
  task_id text NOT NULL CONSTRAINT idx_analysis_model_calls_task UNIQUE REFERENCES analysis_tasks(task_id),
  execution_token text,
  model text NOT NULL,
  status text NOT NULL CONSTRAINT analysis_model_calls_status_check CHECK (status IN ('prepared', 'dispatched', 'completed', 'failed', 'cancelled', 'unknown')),
  http_dispatch_count integer NOT NULL DEFAULT 0 CONSTRAINT analysis_model_calls_dispatch_check CHECK (http_dispatch_count IN (0, 1)),
  request_bytes bigint,
  upstream_request_id text,
  local_rejection text,
  usage jsonb,
  response_content text,
  started_at timestamptz NOT NULL,
  dispatched_at timestamptz,
  finished_at timestamptz
);
--> statement-breakpoint

ALTER TABLE media_references DROP CONSTRAINT media_references_owner_kind_check;
--> statement-breakpoint
ALTER TABLE media_references ADD CONSTRAINT media_references_owner_kind_check CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation', 'batch', 'analysis'));
