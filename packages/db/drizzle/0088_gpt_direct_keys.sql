-- OpenAI 直连多密钥。密钥本身不入库：gpt_direct_key_state 只存 sha256 前 8 位指纹上的
-- 停用与冷却，gpt_direct_usage.key_fingerprint 把每笔花费记到具体那一把。
-- 旧行的 key_fingerprint 为空，单密钥部署仍把它们算进那一把的月预算。
-- 回滚见 drizzle/rollback/0088_gpt_direct_keys.down.sql。
ALTER TABLE "gpt_direct_usage" ADD COLUMN IF NOT EXISTS "key_fingerprint" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gpt_direct_usage_key_created" ON "gpt_direct_usage" USING btree ("key_fingerprint","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpt_direct_key_state" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"disabled_reason" text,
	"cooldown_until" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gpt_direct_key_state_reason_check" CHECK ("disabled_reason" IS NULL OR "disabled_reason" IN ('quota', 'invalid'))
);
