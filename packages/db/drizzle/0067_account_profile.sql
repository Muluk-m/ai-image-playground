ALTER TABLE "users" ADD COLUMN "nickname" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bio" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_key" text;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_nickname_check" CHECK ("nickname" IS NULL OR (char_length("nickname") BETWEEN 2 AND 20 AND "nickname" = btrim("nickname")));
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_bio_check" CHECK ("bio" IS NULL OR (char_length("bio") BETWEEN 1 AND 120 AND "bio" = btrim("bio")));
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "user_agent" text;
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "ip" text;
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "last_active_at" timestamp with time zone;
