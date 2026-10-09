DROP INDEX "idx_agent_batch_attempts_number";
ALTER TABLE "agent_batch_plans" DROP COLUMN "attempt_targets", DROP COLUMN "retry_item_keys", DROP COLUMN "retry_requires_resume";
