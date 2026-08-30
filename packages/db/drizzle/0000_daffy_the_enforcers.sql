CREATE TABLE "daily_quota" (
	"device_id" text NOT NULL,
	"date" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_quota_device_id_date_pk" PRIMARY KEY("device_id","date")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"result_payload" jsonb,
	"error_message" text,
	"error_type" text,
	"submitted_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"user_id" text,
	"client_request_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"device_id" text GENERATED ALWAYS AS (request_payload ->> 'device_id') STORED
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_status_check" CHECK ("users"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_tasks_submitted_at" ON "tasks" USING btree ("submitted_at");--> statement-breakpoint
CREATE INDEX "idx_tasks_next_retry_at" ON "tasks" USING btree ("next_retry_at") WHERE "tasks"."next_retry_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_anonymous_client_request_id" ON "tasks" USING btree ("client_request_id") WHERE "tasks"."user_id" IS NULL AND "tasks"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_tasks_user_client_request_id" ON "tasks" USING btree ("user_id","client_request_id") WHERE "tasks"."user_id" IS NOT NULL AND "tasks"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tasks_user_time" ON "tasks" USING btree ("user_id","submitted_at" DESC NULLS LAST) WHERE "tasks"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_tasks_admin_device_time" ON "tasks" USING btree ("device_id","submitted_at" DESC NULLS LAST,"id" DESC NULLS LAST,"status","model");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires_at" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_username" ON "users" USING btree ("username");