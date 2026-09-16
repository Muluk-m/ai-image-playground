CREATE TABLE "canvas_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"element_count" integer NOT NULL,
	"receipts" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvas_projects" ADD CONSTRAINT "canvas_projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_canvas_projects_owner_id" ON "canvas_projects" USING btree ("user_id","id");