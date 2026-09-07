CREATE TABLE "user_assets" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer NOT NULL,
	"name" text,
	"image_id" text,
	"created_at" timestamp with time zone,
	CONSTRAINT "user_assets_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "user_assets_live_payload_check" CHECK ("user_assets"."deleted_at" IS NOT NULL OR ("user_assets"."name" IS NOT NULL AND "user_assets"."image_id" IS NOT NULL AND "user_assets"."created_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sync_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_templates" (
	"user_id" text NOT NULL,
	"id" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"version" integer NOT NULL,
	"name" text,
	"prompt" text,
	"asset_ids" jsonb,
	"params" jsonb,
	"created_at" timestamp with time zone,
	CONSTRAINT "user_templates_user_id_id_pk" PRIMARY KEY("user_id","id"),
	CONSTRAINT "user_templates_live_payload_check" CHECK ("user_templates"."deleted_at" IS NOT NULL OR ("user_templates"."name" IS NOT NULL AND "user_templates"."prompt" IS NOT NULL AND "user_templates"."created_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "user_assets" ADD CONSTRAINT "user_assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sync_state" ADD CONSTRAINT "user_sync_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_templates" ADD CONSTRAINT "user_templates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_assets_user_version" ON "user_assets" USING btree ("user_id","version");--> statement-breakpoint
CREATE INDEX "idx_user_templates_user_version" ON "user_templates" USING btree ("user_id","version");