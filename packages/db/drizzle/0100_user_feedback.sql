CREATE TABLE "feedback_threads" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "last_message_at" timestamp with time zone NOT NULL,
  "last_user_message_at" timestamp with time zone,
  "last_admin_reply_at" timestamp with time zone,
  "user_last_read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "feedback_threads_user_id_key" UNIQUE ("user_id"),
  CONSTRAINT "feedback_threads_status_check" CHECK ("status" IN ('open', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "feedback_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "thread_id" text NOT NULL,
  "sender_type" text NOT NULL,
  "sender_user_id" text,
  "operator_id" text,
  "body" text DEFAULT '' NOT NULL,
  "attachment_key" text,
  "attachment_mime" text,
  "attachment_bytes" integer,
  "attachment_filename" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "feedback_messages_sender_type_check" CHECK ("sender_type" IN ('user', 'admin')),
  CONSTRAINT "feedback_messages_body_check" CHECK (char_length("body") <= 4000),
  CONSTRAINT "feedback_messages_content_check" CHECK (char_length(btrim("body")) > 0 OR "attachment_key" IS NOT NULL),
  CONSTRAINT "feedback_messages_attachment_mime_check" CHECK ("attachment_mime" IS NULL OR "attachment_mime" IN ('image/png', 'image/jpeg', 'image/webp')),
  CONSTRAINT "feedback_messages_attachment_bytes_check" CHECK ("attachment_bytes" IS NULL OR ("attachment_bytes" > 0 AND "attachment_bytes" <= 10485760)),
  CONSTRAINT "feedback_messages_attachment_check" CHECK (("attachment_key" IS NULL AND "attachment_mime" IS NULL AND "attachment_bytes" IS NULL) OR ("attachment_key" IS NOT NULL AND "attachment_mime" IS NOT NULL AND "attachment_bytes" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "feedback_threads" ADD CONSTRAINT "feedback_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_thread_id_feedback_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."feedback_threads"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feedback_messages" ADD CONSTRAINT "feedback_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_feedback_threads_status_last_message" ON "feedback_threads" USING btree ("status", "last_message_at");
--> statement-breakpoint
CREATE INDEX "idx_feedback_messages_thread_created" ON "feedback_messages" USING btree ("thread_id", "created_at");
