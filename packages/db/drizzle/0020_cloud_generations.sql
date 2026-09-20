CREATE TABLE generation_records (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider text NOT NULL, model text NOT NULL, status text NOT NULL, prompt text NOT NULL,
 created_at timestamptz NOT NULL, started_at timestamptz, completed_at timestamptz,
 revision bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_generation_records_owner_time ON generation_records (user_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE user_change_heads (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, sequence bigint NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE user_changes (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, sequence bigint NOT NULL,
 changes jsonb NOT NULL, created_at timestamptz NOT NULL, CONSTRAINT user_changes_user_id_sequence_pk PRIMARY KEY (user_id, sequence)
);
--> statement-breakpoint
CREATE TABLE generation_commands (
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, command_id text NOT NULL,
 request_hash text NOT NULL, task_id text NOT NULL, submitted_at timestamptz NOT NULL,
 CONSTRAINT generation_commands_user_id_command_id_pk PRIMARY KEY (user_id, command_id)
);
