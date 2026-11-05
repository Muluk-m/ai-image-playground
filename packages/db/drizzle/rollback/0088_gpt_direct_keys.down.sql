DROP TABLE IF EXISTS "gpt_direct_key_state";
DROP INDEX IF EXISTS "idx_gpt_direct_usage_key_created";
ALTER TABLE "gpt_direct_usage" DROP COLUMN IF EXISTS "key_fingerprint";
