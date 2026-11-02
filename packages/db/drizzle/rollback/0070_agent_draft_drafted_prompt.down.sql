DROP INDEX IF EXISTS "idx_tasks_agent_submitted";
DROP INDEX IF EXISTS "idx_agent_generation_drafts_created";
ALTER TABLE "agent_generation_drafts" DROP COLUMN IF EXISTS "drafted_prompt";
