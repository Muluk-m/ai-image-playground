ALTER TABLE "agent_batch_plans" ADD COLUMN "attempt_targets" jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN "retry_item_keys" jsonb NOT NULL DEFAULT '[]'::jsonb, ADD COLUMN "retry_requires_resume" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_batch_attempts_number" ON "agent_batch_attempts" ("batch_id", "item_key", "attempt");
