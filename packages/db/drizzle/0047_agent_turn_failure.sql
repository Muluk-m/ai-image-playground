ALTER TABLE "agent_turns" ADD COLUMN "failure" jsonb;
--> statement-breakpoint
UPDATE "agent_turns" AS t
SET "failure" = jsonb_build_object(
  'code', e.event->>'error',
  'message', 'Original upstream error detail was not recorded by this version.',
  'occurredAt', t.created_at
)
FROM "agent_turn_events" AS e
WHERE t.conversation_id = e.conversation_id AND t.turn_id = e.turn_id
  AND t.stop_reason = 'failed' AND e.event->>'type' = 'turnEnd'
  AND e.event->>'error' IN ('agent_upstream_error', 'agent_run_failed', 'agent_tool_failed', 'agent_context_overflow', 'agent_turn_interrupted');
