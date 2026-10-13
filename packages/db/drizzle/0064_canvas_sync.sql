CREATE TABLE "canvas_documents" (
  "project_id" text PRIMARY KEY REFERENCES "canvas_projects"("id") ON DELETE CASCADE,
  "snapshot" text NOT NULL,
  "sequence" integer NOT NULL DEFAULT 0,
  "compacted_sequence" integer NOT NULL DEFAULT 0,
  "compacted_at" timestamp with time zone NOT NULL,
  "legacy_document" jsonb NOT NULL,
  "migrated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canvas_updates" (
  "project_id" text NOT NULL REFERENCES "canvas_documents"("project_id") ON DELETE CASCADE,
  "sequence" integer NOT NULL,
  "update" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "canvas_updates_project_id_sequence_pk" PRIMARY KEY ("project_id", "sequence")
);
