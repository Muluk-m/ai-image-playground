-- The agent's web search tool spends an extra model call (the gateway's Responses API with the
-- hosted `web_search` tool). It is platform-borne like compaction, but it must not be filed under
-- it: operators read this table to attribute cost, and "compaction" would be a lie. No existing row
-- carries the new value, so this widening is safe in both directions.
ALTER TABLE "agent_model_calls" DROP CONSTRAINT "agent_model_calls_purpose_check";--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_purpose_check" CHECK ("agent_model_calls"."purpose" IN ('conversation', 'compaction', 'handoff', 'web_search'));
