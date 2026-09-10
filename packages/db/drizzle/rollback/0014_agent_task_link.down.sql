DROP INDEX IF EXISTS "idx_tasks_agent_turn";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "agent_turn_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "agent_conversation_id";
