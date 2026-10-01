DROP TABLE "agent_batch_commands";
DROP TABLE "agent_batch_attempts";
DROP INDEX "idx_agent_batches_confirmation";
ALTER TABLE "agent_batches" DROP COLUMN "pause_reason", DROP COLUMN "confirmed_version", DROP COLUMN "confirmation_command_id", DROP COLUMN "device_id";
UPDATE "agent_batches" SET "status" = 'cancelled' WHERE "status" IN ('running', 'paused', 'closed');
ALTER TABLE "agent_batches" DROP CONSTRAINT "agent_batches_status_check";
ALTER TABLE "agent_batches" ADD CONSTRAINT "agent_batches_status_check" CHECK (status IN ('draft', 'cancelled'));
