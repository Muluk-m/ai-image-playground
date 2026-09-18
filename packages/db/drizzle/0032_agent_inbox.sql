-- Conversation inbox: what the agent still has to take in. Queued user messages land here while a
-- turn is running and are consumed in order, one per turn.
CREATE TABLE "agent_inbox" (
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "id" text NOT NULL,
  "seq" integer NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "client_message_id" text,
  "payload" jsonb NOT NULL,
  "attachments" jsonb,
  "consumed_turn_id" text,
  "failure" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "agent_inbox_conversation_id_id_pk" PRIMARY KEY ("conversation_id", "id"),
  CONSTRAINT "agent_inbox_kind_check" CHECK ("kind" IN ('user_message', 'clarification_answer', 'task_result', 'system_event')),
  CONSTRAINT "agent_inbox_status_check" CHECK ("status" IN ('pending', 'consumed', 'cancelled', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_inbox_conversation_seq" ON "agent_inbox" ("conversation_id", "seq");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_inbox_client_message" ON "agent_inbox" ("conversation_id", "client_message_id") WHERE "client_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "idx_agent_inbox_pending" ON "agent_inbox" ("conversation_id", "seq") WHERE "status" = 'pending';
