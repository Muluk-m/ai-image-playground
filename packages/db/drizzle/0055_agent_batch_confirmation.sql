ALTER TABLE "agent_batch_plans" ADD COLUMN "confirmation" jsonb;
ALTER TABLE "agent_batch_items" ADD COLUMN "source_analysis" jsonb;
