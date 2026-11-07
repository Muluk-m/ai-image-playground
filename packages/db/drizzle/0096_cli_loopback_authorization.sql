-- Loopback sign-in: an approved device authorization can hand the CLI a one-time code bound to
-- its PKCE challenge. All columns are nullable, so older backends keep working unchanged.
ALTER TABLE "device_authorizations" ADD COLUMN IF NOT EXISTS "redirect_uri" text;
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN IF NOT EXISTS "code_challenge" text;
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN IF NOT EXISTS "authorization_code_hash" text;
--> statement-breakpoint
ALTER TABLE "device_authorizations" ADD COLUMN IF NOT EXISTS "authorization_code_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_authorizations_authorization_code_hash"
  ON "device_authorizations" ("authorization_code_hash");
