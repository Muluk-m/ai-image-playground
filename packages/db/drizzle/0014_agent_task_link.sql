ALTER TABLE "tasks" ADD COLUMN "agent_conversation_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_turn_id" text;--> statement-breakpoint
CREATE INDEX "idx_tasks_agent_turn" ON "tasks" USING btree ("agent_conversation_id","agent_turn_id") WHERE "tasks"."agent_turn_id" IS NOT NULL;