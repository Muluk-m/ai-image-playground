CREATE TABLE "announcements" (
  "id" text PRIMARY KEY NOT NULL,
  "type" text NOT NULL,
  "importance" text DEFAULT 'normal' NOT NULL,
  "title_zh" text NOT NULL,
  "body_zh" text DEFAULT '' NOT NULL,
  "title_en" text,
  "body_en" text,
  "cover_key" text,
  "cta_label" text,
  "cta_url" text,
  "version_tag" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "publish_at" timestamp with time zone,
  "expire_at" timestamp with time zone,
  "audience" text DEFAULT 'all' NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "announcements_type_check" CHECK ("type" IN ('feature', 'improvement', 'notice')),
  CONSTRAINT "announcements_importance_check" CHECK ("importance" IN ('normal', 'major')),
  CONSTRAINT "announcements_status_check" CHECK ("status" IN ('draft', 'scheduled', 'published', 'archived')),
  CONSTRAINT "announcements_audience_check" CHECK ("audience" IN ('all', 'logged_in', 'anonymous')),
  CONSTRAINT "announcements_title_zh_check" CHECK (char_length("title_zh") BETWEEN 1 AND 80),
  CONSTRAINT "announcements_body_zh_check" CHECK (char_length("body_zh") <= 20000),
  CONSTRAINT "announcements_title_en_check" CHECK ("title_en" IS NULL OR char_length("title_en") BETWEEN 1 AND 80),
  CONSTRAINT "announcements_body_en_check" CHECK ("body_en" IS NULL OR char_length("body_en") <= 20000),
  CONSTRAINT "announcements_cta_check" CHECK (("cta_label" IS NULL AND "cta_url" IS NULL) OR ("cta_label" IS NOT NULL AND "cta_url" IS NOT NULL AND char_length(btrim("cta_label")) > 0 AND char_length(btrim("cta_url")) > 0)),
  CONSTRAINT "announcements_window_check" CHECK ("expire_at" IS NULL OR "publish_at" IS NULL OR "expire_at" > "publish_at")
);
--> statement-breakpoint
CREATE TABLE "announcement_reads" (
  "user_id" text NOT NULL,
  "announcement_id" text NOT NULL,
  "read_at" timestamp with time zone,
  "dismissed_at" timestamp with time zone,
  CONSTRAINT "announcement_reads_pkey" PRIMARY KEY ("user_id", "announcement_id")
);
--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "announcement_reads" ADD CONSTRAINT "announcement_reads_announcement_id_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."announcements"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_announcements_status_publish" ON "announcements" USING btree ("status", "publish_at");
--> statement-breakpoint
CREATE INDEX "idx_announcement_reads_announcement" ON "announcement_reads" USING btree ("announcement_id");
