-- Tool call arguments are recorded when the call starts; the result card only lands at the end.
CREATE TABLE "agent_tool_calls" (
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "message_id" text NOT NULL,
  "turn_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "tool_name" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "agent_tool_calls_conversation_id_message_id_pk" PRIMARY KEY ("conversation_id", "message_id")
);
--> statement-breakpoint
CREATE INDEX "idx_agent_tool_calls_turn" ON "agent_tool_calls" ("conversation_id", "turn_id");
