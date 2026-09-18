-- Background job registry: one row per generation task an agent tool submitted, with the agent's
-- wake-on-success choice. The worker ends the task and, in the same transaction, decides whether the
-- submitting turn's batch is ready to wake the agent; `delivered_at` makes a batch wake only once.
CREATE TABLE "agent_jobs" (
  "task_id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "turn_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "wake_on_success" boolean DEFAULT false NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "delivered_at" timestamp with time zone,
  "wake_id" text
);
--> statement-breakpoint
CREATE INDEX "idx_agent_jobs_undelivered" ON "agent_jobs" ("conversation_id", "turn_id") WHERE "delivered_at" IS NULL;
