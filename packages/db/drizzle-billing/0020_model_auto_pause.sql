-- 上游没有可用账号时系统自动下架模型，记下原因与时间，后台据此区分「自动暂停」与运营手动下架。
ALTER TABLE "billing_model_prices" ADD COLUMN IF NOT EXISTS "pause_reason" text;
ALTER TABLE "billing_model_prices" ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
