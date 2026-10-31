CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);

INSERT INTO "oauth_clients" ("id", "name", "created_at")
VALUES ('muvloom-cli', 'Muvloom CLI', now())
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "device_authorizations" (
  "id" text PRIMARY KEY NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "device_code_hash" text NOT NULL,
  "user_code_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "user_id" text REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamp with time zone NOT NULL,
  "interval_seconds" integer DEFAULT 5 NOT NULL,
  "last_polled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "device_authorizations_status_check" CHECK ("status" IN ('pending', 'approved', 'denied', 'expired'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_authorizations_device_code_hash" ON "device_authorizations" ("device_code_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_device_authorizations_user_code_hash" ON "device_authorizations" ("user_code_hash");
CREATE INDEX IF NOT EXISTS "idx_device_authorizations_expires_at" ON "device_authorizations" ("expires_at");
CREATE INDEX IF NOT EXISTS "idx_device_authorizations_user_id" ON "device_authorizations" ("user_id");

CREATE TABLE IF NOT EXISTS "cli_connections" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "family_id" text NOT NULL,
  "access_token_hash" text NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "access_expires_at" timestamp with time zone NOT NULL,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cli_connections_access_token_hash" ON "cli_connections" ("access_token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cli_connections_refresh_token_hash" ON "cli_connections" ("refresh_token_hash");
CREATE INDEX IF NOT EXISTS "idx_cli_connections_user_id" ON "cli_connections" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_cli_connections_family_id" ON "cli_connections" ("family_id");
