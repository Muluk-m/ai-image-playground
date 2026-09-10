CREATE TABLE "agent_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"device_id" text,
	"title" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_conversations_owner_check" CHECK (("agent_conversations"."user_id" IS NULL) <> ("agent_conversations"."device_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"conversation_id" text NOT NULL,
	"id" text NOT NULL,
	"turn_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_messages_conversation_id_id_pk" PRIMARY KEY("conversation_id","id"),
	CONSTRAINT "agent_messages_role_check" CHECK ("agent_messages"."role" IN ('user', 'assistant', 'tool'))
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_conversations_user_time" ON "agent_conversations" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE "agent_conversations"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_conversations_device_time" ON "agent_conversations" USING btree ("device_id","updated_at" DESC NULLS LAST) WHERE "agent_conversations"."device_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_messages_conversation_seq" ON "agent_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "idx_agent_messages_turn" ON "agent_messages" USING btree ("conversation_id","turn_id");