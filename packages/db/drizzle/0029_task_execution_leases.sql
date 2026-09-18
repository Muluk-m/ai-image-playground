ALTER TABLE tasks ADD COLUMN execution_token text;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN lease_expires_at timestamptz;
--> statement-breakpoint
CREATE INDEX idx_tasks_lease_expires ON tasks (lease_expires_at) WHERE status = 'in_progress';
--> statement-breakpoint
CREATE TABLE agent_executions (
  conversation_id text PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  instance text NOT NULL,
  origin text NOT NULL,
  state text NOT NULL CONSTRAINT agent_executions_state_check CHECK (state IN ('running', 'completed', 'failed')),
  heartbeat_at timestamptz NOT NULL
);
--> statement-breakpoint
ALTER TABLE agent_conversations ADD COLUMN runtime_generation integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE deployment_controls (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false);
--> statement-breakpoint
INSERT INTO deployment_controls (key, enabled) VALUES ('legacy_claims_disabled', false);
--> statement-breakpoint
CREATE FUNCTION guard_legacy_task_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate_enabled boolean;
BEGIN
  SELECT enabled INTO gate_enabled FROM deployment_controls WHERE key = 'legacy_claims_disabled' FOR SHARE;
  IF OLD.status = 'queued' AND NEW.status = 'in_progress' AND NEW.execution_token IS NULL
     AND gate_enabled THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guard_legacy_task_claim BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_legacy_task_claim();
