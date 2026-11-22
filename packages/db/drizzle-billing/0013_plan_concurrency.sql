ALTER TABLE "billing_plans"
  ADD COLUMN "max_concurrent_tasks" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
UPDATE "billing_plans" SET "max_concurrent_tasks" = 2 WHERE "id" = 'standard';
--> statement-breakpoint
UPDATE "billing_plans" SET "max_concurrent_tasks" = 3 WHERE "id" = 'professional';
--> statement-breakpoint
ALTER TABLE "billing_plans"
  ADD CONSTRAINT "billing_plans_max_concurrent_tasks_check"
  CHECK ("max_concurrent_tasks" >= 1);
