ALTER TABLE "tasks" ADD COLUMN "upstream_task_ids" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "upstream_submitted_at" timestamp with time zone;