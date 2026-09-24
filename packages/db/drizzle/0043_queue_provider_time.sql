CREATE INDEX "idx_tasks_queued_provider_time" ON "tasks" USING btree ("provider", "submitted_at", "id") WHERE "status" = 'queued';
CREATE INDEX "idx_tasks_queued_provider_eligible" ON "tasks" USING btree ("provider", greatest("submitted_at", coalesce("next_retry_at", "submitted_at")), "id") WHERE "status" = 'queued';
