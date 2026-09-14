CREATE TABLE "agent_turns" (
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"stop_reason" text NOT NULL,
	"cost" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_turns_conversation_id_turn_id_pk" PRIMARY KEY("conversation_id","turn_id"),
	CONSTRAINT "agent_turns_stop_reason_check" CHECK ("agent_turns"."stop_reason" IN ('completed', 'aborted', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "agent_turns" ADD CONSTRAINT "agent_turns_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "agent_turns" ("conversation_id", "turn_id", "duration_ms", "stop_reason", "cost", "created_at")
SELECT "conversation_id",
	"turn_id",
	("event" ->> 'durationMs')::integer,
	"event" ->> 'stopReason',
	"event" -> 'cost',
	"created_at"
FROM "agent_turn_events"
WHERE "event" ->> 'type' = 'turnEnd'
	AND "event" ->> 'stopReason' IN ('completed', 'aborted', 'failed')
ON CONFLICT DO NOTHING;
