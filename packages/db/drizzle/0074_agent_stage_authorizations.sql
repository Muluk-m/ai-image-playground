CREATE TABLE "agent_stage_authorizations" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "conversation_id" text NOT NULL REFERENCES "agent_conversations"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "canvas_projects"("id") ON DELETE CASCADE,
  "proposal_key" text NOT NULL,
  "execution_token_hash" text,
  "state" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_stage_proposal" ON "agent_stage_authorizations" ("conversation_id", "proposal_key");
--> statement-breakpoint
CREATE INDEX "idx_agent_stage_owner" ON "agent_stage_authorizations" ("user_id", "conversation_id");
