-- OpenAI 直连多密钥。密钥本身不入库：gpt_direct_key_state 只存 HMAC-SHA256 前 8 位指纹上的
-- 停用与冷却，gpt_direct_usage.key_fingerprint 把每笔花费记到具体那一把。
-- 旧行的 key_fingerprint 为空，单密钥部署仍把它们算进那一把的月预算。
-- 后台配置的直连密钥用与 upstream_api_secrets 相同的 AES-256-GCM 字段，明文不入库。
-- 回滚见 drizzle/rollback/0091_gpt_direct_keys.down.sql。
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
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpt_direct_admin_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"ordinal" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"budget_usd" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"nonce" text NOT NULL,
	"tag" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "gpt_direct_admin_keys_ordinal_check" CHECK ("ordinal" > 0),
	CONSTRAINT "gpt_direct_admin_keys_budget_check" CHECK ("budget_usd" > 0),
	CONSTRAINT "gpt_direct_admin_keys_fingerprint_key" UNIQUE ("fingerprint"),
	CONSTRAINT "gpt_direct_admin_keys_ordinal_key" UNIQUE ("ordinal") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gpt_direct_budget_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gpt_direct_budget_holds_key" ON "gpt_direct_budget_holds" USING btree ("fingerprint","month_start");
