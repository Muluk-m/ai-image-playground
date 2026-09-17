ALTER TABLE "canvas_projects" ADD COLUMN "conversation_id" text REFERENCES "agent_conversations"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_canvas_projects_conversation" ON "canvas_projects" ("conversation_id");
