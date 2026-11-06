-- Deploy a version that does not read request_key_hash before executing this rollback.
DROP INDEX IF EXISTS "idx_user_retired_refresh_request";
ALTER TABLE "user_retired_refresh_tokens" DROP COLUMN IF EXISTS "request_key_hash";
