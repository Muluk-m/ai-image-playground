DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_batch_attempts" a
    LEFT JOIN "tasks" t ON t.id = a.task_id
    WHERE a.terminal_snapshot IS NULL
      OR a.terminal_snapshot ->> 'errorCode' = 'result_unknown'
      OR a.terminal_snapshot ->> 'status' NOT IN ('completed', 'failed', 'cancelled')
      OR a.terminal_snapshot ->> 'actualCredits' IS NULL
      OR t.status NOT IN ('completed', 'failed', 'cancelled')
  ) THEN
    RAISE EXCEPTION 'cannot roll back execution with unsettled batch attempts';
  END IF;
END $$;
DROP TABLE "agent_batch_commands";
DROP TABLE "agent_batch_attempts";
DROP INDEX "idx_agent_batches_confirmation";
ALTER TABLE "agent_batches" DROP COLUMN "pause_reason", DROP COLUMN "confirmed_version", DROP COLUMN "confirmation_command_id", DROP COLUMN "device_id";
UPDATE "agent_batches" SET "status" = 'cancelled' WHERE "status" IN ('running', 'paused', 'closed');
ALTER TABLE "agent_batches" DROP CONSTRAINT "agent_batches_status_check";
ALTER TABLE "agent_batches" ADD CONSTRAINT "agent_batches_status_check" CHECK (status IN ('draft', 'cancelled'));
