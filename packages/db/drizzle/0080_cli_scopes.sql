ALTER TABLE "device_authorizations" ADD COLUMN IF NOT EXISTS "scopes" text NOT NULL DEFAULT 'images:read images:write media:read media:write';
ALTER TABLE "cli_connections" ADD COLUMN IF NOT EXISTS "scopes" text NOT NULL DEFAULT 'images:read images:write media:read media:write';
