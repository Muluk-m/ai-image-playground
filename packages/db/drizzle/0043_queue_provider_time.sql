CREATE INDEX "idx_tasks_queued_provider_time" ON "tasks" USING btree ("provider", "submitted_at", "id") WHERE "status" = 'queued';
