-- Deploy a version that does not read these columns before executing this rollback.
DROP INDEX IF EXISTS "idx_device_authorizations_authorization_code_hash";
ALTER TABLE "device_authorizations" DROP COLUMN IF EXISTS "authorization_code_expires_at";
ALTER TABLE "device_authorizations" DROP COLUMN IF EXISTS "authorization_code_hash";
ALTER TABLE "device_authorizations" DROP COLUMN IF EXISTS "code_challenge";
ALTER TABLE "device_authorizations" DROP COLUMN IF EXISTS "redirect_uri";
