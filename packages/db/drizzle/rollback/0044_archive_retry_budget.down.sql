DROP INDEX "idx_tasks_queued_provider_eligible";
ALTER TABLE "tasks" DROP COLUMN "archive_retry_started_at";
