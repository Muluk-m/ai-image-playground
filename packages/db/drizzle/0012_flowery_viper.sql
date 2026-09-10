CREATE TABLE "agent_turn_events" (
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"turn_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_turn_events_conversation_id_seq_pk" PRIMARY KEY("conversation_id","seq")
);
--> statement-breakpoint
ALTER TABLE "agent_turn_events" ADD CONSTRAINT "agent_turn_events_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_turn_events_turn" ON "agent_turn_events" USING btree ("conversation_id","turn_id","seq");--> statement-breakpoint
CREATE INDEX "idx_agent_turn_events_created" ON "agent_turn_events" USING btree ("created_at");