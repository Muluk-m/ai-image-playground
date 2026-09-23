-- Narrowing back would fail on rows already filed as 'web_search', so drop those first: they are
-- platform-borne usage records, never settlement input, and the release that needs this rollback
-- has no code left that reads them.
DELETE FROM "agent_model_calls" WHERE "purpose" = 'web_search';
ALTER TABLE "agent_model_calls" DROP CONSTRAINT IF EXISTS "agent_model_calls_purpose_check";
ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_purpose_check" CHECK ("agent_model_calls"."purpose" IN ('conversation', 'compaction', 'handoff'));
