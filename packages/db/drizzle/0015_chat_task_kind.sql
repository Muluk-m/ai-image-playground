ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_kind_check" CHECK ("kind" IN ('queue', 'chat'));--> statement-breakpoint
CREATE VIEW "queue_tasks" AS SELECT * FROM "tasks" WHERE "kind" = 'queue';
