-- 0092 is reserved by an unrelated, unmerged password-reset migration.
-- Remember completed operations across tabs; NULL preserves old-version inserts.
ALTER TABLE "user_retired_refresh_tokens" ADD COLUMN IF NOT EXISTS "request_key_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_retired_refresh_request"
  ON "user_retired_refresh_tokens" ("family_id", "request_key_hash");
