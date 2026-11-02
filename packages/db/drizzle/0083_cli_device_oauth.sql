-- 原编号 0081 已在测试库执行，但时间戳早于 main 上的 0082，生产会跳过它，所以按「已应用的迁移不改号、新加一条」
-- 换成本条。全部语句幂等：测试库已有这些表，重复执行不改变结构。

CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "oauth_clients" ("id", "name", "created_at")
VALUES ('muvloom-cli', 'Muvloom CLI', now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_authorizations" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "device_code_hash" text NOT NULL,
  "user_code_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "scopes" text NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "interval_seconds" integer NOT NULL,
  "last_polled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "device_authorizations_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_authorizations_device_code_hash" ON "device_authorizations" ("device_code_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_authorizations_user_code_hash" ON "device_authorizations" ("user_code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_device_authorizations_expires_at" ON "device_authorizations" ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "scopes" text NOT NULL,
  "access_token_hash" text NOT NULL,
  "access_expires_at" timestamp with time zone NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cli_connections_access_token_hash" ON "cli_connections" ("access_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cli_connections_refresh_token_hash" ON "cli_connections" ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cli_connections_user_id" ON "cli_connections" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_retired_refresh_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "connection_id" text NOT NULL REFERENCES "cli_connections"("id") ON DELETE CASCADE,
  "retired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cli_retired_refresh_tokens_connection" ON "cli_retired_refresh_tokens" ("connection_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_jobs" (
  "task_id" text PRIMARY KEY NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "connection_id" text REFERENCES "cli_connections"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cli_jobs_user_created" ON "cli_jobs" ("user_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cli_reference_media" (
  "media_id" text PRIMARY KEY NOT NULL REFERENCES "media_objects"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cli_reference_media_user_created" ON "cli_reference_media" ("user_id", "created_at");
