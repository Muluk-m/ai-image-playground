ALTER TABLE "tasks" ADD COLUMN "archive_retry_started_at" timestamp with time zone;
CREATE INDEX "idx_tasks_queued_provider_eligible" ON "tasks" USING btree ("provider", greatest("submitted_at", coalesce("next_retry_at", "submitted_at")), "id") WHERE "status" = 'queued';
