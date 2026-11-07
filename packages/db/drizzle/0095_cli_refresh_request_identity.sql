-- CLI refresh retries carry a request identity; NULL keeps rows written by older backends valid.
ALTER TABLE "cli_retired_refresh_tokens" ADD COLUMN IF NOT EXISTS "request_key_hash" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cli_retired_refresh_request"
  ON "cli_retired_refresh_tokens" ("connection_id", "request_key_hash");
