DROP VIEW IF EXISTS "queue_tasks";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_kind_check";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "kind";
