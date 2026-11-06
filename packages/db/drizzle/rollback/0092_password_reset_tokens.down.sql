DROP INDEX IF EXISTS "idx_password_reset_tokens_expires_at";
DROP INDEX IF EXISTS "idx_password_reset_tokens_user";
DROP INDEX IF EXISTS "idx_password_reset_tokens_hash";
DROP TABLE IF EXISTS "password_reset_tokens";
