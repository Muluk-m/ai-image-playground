-- Pending generation drafts: one row per generation tool call that prepared a complete request but
-- has not spent anything yet. The agent only drafts; the user edits the prompt on the card and
-- confirms, and only then does a task row exist. Input images and masks live in object storage
-- under the draft id, so no pixel bytes are stored here. `id` doubles as the idempotency command id
-- carried into `tasks.client_request_id`: a process that dies between creating the task and writing
-- `task_id` back finds that task again on the next confirmation instead of paying twice.
CREATE TABLE "agent_generation_drafts" (
  "id" text PRIMARY KEY NOT NULL,
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "turn_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "media" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "prompt" text NOT NULL,
  "request" jsonb NOT NULL,
  "submission" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "task_id" text,
  "confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_generation_drafts_call" ON "agent_generation_drafts" ("conversation_id", "turn_id", "tool_call_id");
