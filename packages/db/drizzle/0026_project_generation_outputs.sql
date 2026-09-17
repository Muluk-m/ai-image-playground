-- Generation publication acquires the account sequence last; check this relation at commit.
CREATE TABLE "project_generation_outputs" (
  "generation_id" text NOT NULL REFERENCES "generation_records"("id") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  "position" integer NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "canvas_projects"("id") ON DELETE CASCADE,
  "conversation_id" text NOT NULL,
  "turn_id" text NOT NULL,
  "object_id" text NOT NULL,
  PRIMARY KEY ("generation_id", "position")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_generation_objects" ON "project_generation_outputs" ("project_id", "object_id");
