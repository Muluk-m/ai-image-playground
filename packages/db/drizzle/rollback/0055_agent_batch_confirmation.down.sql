DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "agent_batch_plans" WHERE "confirmation" IS NOT NULL) OR EXISTS (SELECT 1 FROM "agent_batch_items" WHERE "source_analysis" IS NOT NULL) THEN
    RAISE EXCEPTION 'cannot discard confirmed batch phase authorization';
  END IF;
END $$;
ALTER TABLE "agent_batch_items" DROP COLUMN "source_analysis";
ALTER TABLE "agent_batch_plans" DROP COLUMN "confirmation";
