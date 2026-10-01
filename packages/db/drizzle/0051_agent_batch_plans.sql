CREATE TABLE "agent_batches" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" text REFERENCES "agent_conversations"("id") ON DELETE SET NULL,
  "origin_turn_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "experience" text NOT NULL CHECK (experience IN ('chat', 'canvas')),
  "project_id" text,
  "project_revision" integer,
  "current_version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'cancelled')),
  "dispatch_generation" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_batches_call" ON "agent_batches" ("conversation_id", "origin_turn_id", "tool_call_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_batches_owner_conversation" ON "agent_batches" ("user_id", "conversation_id", "created_at", "id");
--> statement-breakpoint
CREATE TABLE "agent_batch_plans" (
  "batch_id" text NOT NULL REFERENCES "agent_batches"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "title" text NOT NULL,
  "rule" text NOT NULL,
  "digest" text NOT NULL,
  "item_count" integer NOT NULL,
  "estimate_snapshot" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("batch_id", "version")
);
--> statement-breakpoint
CREATE TABLE "agent_batch_items" (
  "batch_id" text NOT NULL REFERENCES "agent_batches"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "key" text NOT NULL,
  "ordinal" integer NOT NULL,
  "kind" text NOT NULL,
  "inputs" jsonb NOT NULL,
  "prompt" text NOT NULL,
  "params" jsonb NOT NULL,
  "dependencies" jsonb NOT NULL,
  PRIMARY KEY ("batch_id", "version", "key"),
  FOREIGN KEY ("batch_id", "version") REFERENCES "agent_batch_plans"("batch_id", "version") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_batch_items_order" ON "agent_batch_items" ("batch_id", "version", "ordinal");
--> statement-breakpoint
ALTER TABLE "media_references" DROP CONSTRAINT "media_references_owner_kind_check";
--> statement-breakpoint
ALTER TABLE "media_references" ADD CONSTRAINT "media_references_owner_kind_check" CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation', 'batch'));
