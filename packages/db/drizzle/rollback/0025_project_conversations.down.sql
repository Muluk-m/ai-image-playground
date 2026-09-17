DROP INDEX IF EXISTS "idx_canvas_projects_conversation";
ALTER TABLE "canvas_projects" DROP COLUMN IF EXISTS "conversation_id";
