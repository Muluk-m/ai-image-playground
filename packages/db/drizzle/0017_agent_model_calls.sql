CREATE TABLE "agent_model_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"user_id" text,
	"device_id" text NOT NULL,
	"purpose" text NOT NULL,
	"model" text NOT NULL,
	"input_image_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"usage" jsonb,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"tool_calls" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_model_calls_purpose_check" CHECK ("agent_model_calls"."purpose" IN ('conversation', 'compaction', 'handoff')),
	CONSTRAINT "agent_model_calls_status_check" CHECK ("agent_model_calls"."status" IN ('in_progress', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD CONSTRAINT "agent_model_calls_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_model_calls_turn" ON "agent_model_calls" USING btree ("conversation_id","turn_id");