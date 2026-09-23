-- A look ("模板" in the UI) is a tuned image effect whose form is a skill: frontmatter fields plus a
-- sectioned markdown body. Users create them in conversation, so they are stored per user and ride
-- the same sync record columns and tombstone rule as templates and assets. Reference images and the
-- cover live in the asset object ledger and count against the same `sync:asset-image-bytes` quota,
-- so only the ids are kept here. The old "模板" keeps `user_templates`; this table is the new one.
CREATE TABLE "user_looks" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer NOT NULL,
	"name" text,
	"description" text,
	"purpose" text,
	"body" text,
	"model" text,
	"size" text,
	"slot_count" integer,
	"reference_image_ids" jsonb,
	"cover_image_id" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "user_looks_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "user_looks_live_payload_check" CHECK ("user_looks"."deleted_at" IS NOT NULL OR ("user_looks"."name" IS NOT NULL AND "user_looks"."description" IS NOT NULL AND "user_looks"."body" IS NOT NULL AND "user_looks"."created_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "user_looks" ADD CONSTRAINT "user_looks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_looks_user_version" ON "user_looks" USING btree ("user_id","version");
