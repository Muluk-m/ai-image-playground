ALTER TABLE "billing_task_holds" ADD COLUMN "credits_per_unit" integer CHECK ("credits_per_unit" > 0);
