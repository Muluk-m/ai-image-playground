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
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_owner_id_key" UNIQUE ("user_id", "id");
--> statement-breakpoint
ALTER TABLE "canvas_projects" ADD CONSTRAINT "canvas_projects_owner_id_key" UNIQUE ("user_id", "id");
--> statement-breakpoint
-- project.conversation_id 在提案事务里核对。不把 (id, conversation_id) 做成外键：
-- 会话删除会把项目的 conversation_id 置空，复合外键会在授权行还在时挡住这次更新。
ALTER TABLE "agent_stage_authorizations" ADD CONSTRAINT "agent_stage_authorizations_owner_conversation_fk" FOREIGN KEY ("user_id", "conversation_id") REFERENCES "agent_conversations" ("user_id", "id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "agent_stage_authorizations" ADD CONSTRAINT "agent_stage_authorizations_owner_project_fk" FOREIGN KEY ("user_id", "project_id") REFERENCES "canvas_projects" ("user_id", "id") ON DELETE CASCADE;
