ALTER TABLE "agent_generation_drafts" ADD COLUMN "drafted_prompt" text;
--> statement-breakpoint
CREATE INDEX "idx_agent_generation_drafts_created" ON "agent_generation_drafts" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_tasks_agent_submitted" ON "tasks" ("submitted_at" DESC, "id" DESC) WHERE "agent_conversation_id" IS NOT NULL;
