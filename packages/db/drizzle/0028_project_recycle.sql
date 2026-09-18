ALTER TABLE "canvas_projects" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "canvas_projects" ADD COLUMN "restore_until" timestamp with time zone;
