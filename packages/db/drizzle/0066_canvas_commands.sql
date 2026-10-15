CREATE TABLE "canvas_commands" (
  "id" text PRIMARY KEY,
  "project_id" text NOT NULL REFERENCES "canvas_documents"("project_id") ON DELETE CASCADE,
  "turn_id" text NOT NULL,
  "tool_call_id" text NOT NULL,
  "fingerprint" text NOT NULL,
  "label" text NOT NULL,
  "before" text NOT NULL,
  "update" text NOT NULL,
  "reversed" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_canvas_commands_call" ON "canvas_commands" ("project_id", "turn_id", "tool_call_id");
--> statement-breakpoint
CREATE INDEX "idx_canvas_commands_project_created" ON "canvas_commands" ("project_id", "created_at");
