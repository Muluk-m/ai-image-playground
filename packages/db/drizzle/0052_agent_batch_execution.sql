ALTER TABLE "agent_batches" DROP CONSTRAINT "agent_batches_status_check";
--> statement-breakpoint
ALTER TABLE "agent_batches" ADD CONSTRAINT "agent_batches_status_check" CHECK (status IN ('draft', 'cancelled', 'running', 'paused', 'closed'));
--> statement-breakpoint
ALTER TABLE "agent_batches" ADD COLUMN "pause_reason" text, ADD COLUMN "confirmed_version" integer, ADD COLUMN "confirmation_command_id" text, ADD COLUMN "device_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_batches_confirmation" ON "agent_batches" ("user_id", "confirmation_command_id");
--> statement-breakpoint
CREATE TABLE "agent_batch_attempts" (
  "batch_id" text NOT NULL,
  "version" integer NOT NULL,
  "item_key" text NOT NULL,
  "attempt" integer NOT NULL,
  "task_id" text NOT NULL,
  "price_snapshot" jsonb,
  "reserved_credits" integer NOT NULL,
  "submitted_at" timestamptz NOT NULL,
  PRIMARY KEY ("batch_id", "version", "item_key", "attempt"),
  FOREIGN KEY ("batch_id", "version", "item_key") REFERENCES "agent_batch_items" ("batch_id", "version", "key") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_batch_attempts_task" ON "agent_batch_attempts" ("task_id");
--> statement-breakpoint
CREATE TABLE "agent_batch_commands" (
  "batch_id" text NOT NULL REFERENCES "agent_batches"("id") ON DELETE CASCADE,
  "command_id" text NOT NULL,
  "kind" text NOT NULL,
  "request_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("batch_id", "command_id")
);
