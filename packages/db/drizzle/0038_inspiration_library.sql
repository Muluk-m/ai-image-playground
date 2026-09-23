CREATE TABLE "inspiration_categories" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "inspiration_categories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "inspiration_items" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "featured" boolean DEFAULT false NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "category_id" text NOT NULL,
  "prompt" text NOT NULL,
  "recommended_provider" text NOT NULL,
  "recommended_model" text NOT NULL,
  "params" jsonb NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cover_key" text NOT NULL,
  "image_key" text,
  "reference_images" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "skill_name" text,
  "source_url" text,
  "author" text,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "updated_by" text NOT NULL,
  "published_at" timestamp with time zone,
  CONSTRAINT "inspiration_items_kind_check" CHECK ("inspiration_items"."kind" IN ('showcase', 'template', 'skill')),
  CONSTRAINT "inspiration_items_status_check" CHECK ("inspiration_items"."status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "inspiration_publications" (
  "version" integer PRIMARY KEY NOT NULL,
  "published_at" timestamp with time zone NOT NULL,
  "item_count" integer NOT NULL,
  "manifest_hash" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspiration_items" ADD CONSTRAINT "inspiration_items_category_id_inspiration_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."inspiration_categories"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_inspiration_items_public" ON "inspiration_items" USING btree ("status","sort","id");
--> statement-breakpoint
CREATE INDEX "idx_inspiration_items_category" ON "inspiration_items" USING btree ("category_id","sort","id");
