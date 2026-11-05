-- 网页会话改成 access + refresh。只加表和可空列，不改已有 user_sessions 行。
-- family_id 为空的旧会话在原来的 expires_at 之前继续有效，刷新时再升级。
-- 回滚见 drizzle/rollback/0087_web_session_refresh.down.sql：去掉新表和新列后，
-- 已经写在 user_sessions 里的 access 行还在，到期前照常能用。
CREATE TABLE "user_session_families" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "refresh_token_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "refreshed_at" timestamp with time zone NOT NULL,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "absolute_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoke_reason" text,
  "user_agent" text,
  "ip" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_session_families_refresh_token_hash" ON "user_session_families" ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX "idx_user_session_families_user_id" ON "user_session_families" ("user_id");
--> statement-breakpoint
CREATE TABLE "user_retired_refresh_tokens" (
  "token_hash" text PRIMARY KEY NOT NULL,
  "family_id" text NOT NULL REFERENCES "user_session_families"("id") ON DELETE CASCADE,
  "retired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_user_retired_refresh_tokens_family" ON "user_retired_refresh_tokens" ("family_id");
--> statement-breakpoint
ALTER TABLE "user_sessions" ADD COLUMN "family_id" text REFERENCES "user_session_families"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "idx_user_sessions_family_id" ON "user_sessions" ("family_id");
