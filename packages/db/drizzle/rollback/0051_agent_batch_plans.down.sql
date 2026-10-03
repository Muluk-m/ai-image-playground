DELETE FROM "media_references" WHERE "owner_kind" = 'batch';
ALTER TABLE "media_references" DROP CONSTRAINT "media_references_owner_kind_check";
ALTER TABLE "media_references" ADD CONSTRAINT "media_references_owner_kind_check" CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation'));
DROP TABLE "agent_batch_items";
DROP TABLE "agent_batch_plans";
DROP TABLE "agent_batches";
