-- Gemini 直连（Vertex / Nano Banana）多密钥池、月预算预占与调用统计。
-- 密钥明文不入库：gemini_direct_admin_keys 沿用与 upstream_api_secrets 相同的 AES-256-GCM 密文字段；
-- gemini_direct_key_state 仅按 HMAC/scrypt 8 位指纹记录停用与 429 冷却；
-- gemini_direct_usage 记录每次调用状态（ok / rate_limited / error）、出图数、token 与估算花费（micro-USD）。
-- 回滚见 drizzle/rollback/0103_gemini_direct_keys.down.sql。
CREATE TABLE IF NOT EXISTS "gemini_direct_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"model" text NOT NULL,
	"image_size" text,
	"images" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micro_usd" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"upstream_status" integer,
	"key_fingerprint" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gemini_direct_usage_status_check" CHECK ("status" IN ('ok', 'rate_limited', 'error'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gemini_direct_usage_created" ON "gemini_direct_usage" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gemini_direct_usage_key_created" ON "gemini_direct_usage" USING btree ("key_fingerprint","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gemini_direct_key_state" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"disabled_reason" text,
	"cooldown_until" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gemini_direct_key_state_reason_check" CHECK ("disabled_reason" IS NULL OR "disabled_reason" IN ('quota', 'invalid'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gemini_direct_admin_keys" (
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
	CONSTRAINT "gemini_direct_admin_keys_ordinal_check" CHECK ("ordinal" > 0),
	CONSTRAINT "gemini_direct_admin_keys_budget_check" CHECK ("budget_usd" > 0),
	CONSTRAINT "gemini_direct_admin_keys_fingerprint_key" UNIQUE ("fingerprint"),
	CONSTRAINT "gemini_direct_admin_keys_ordinal_key" UNIQUE ("ordinal") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gemini_direct_budget_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"month_start" timestamp with time zone NOT NULL,
	"micro_usd" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gemini_direct_budget_holds_key" ON "gemini_direct_budget_holds" USING btree ("fingerprint","month_start");
