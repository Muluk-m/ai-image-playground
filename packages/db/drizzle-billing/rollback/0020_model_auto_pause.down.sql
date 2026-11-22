-- 自动暂停的模型回滚后仍是下架状态（active=false），只是不再区分原因；需要的话先在后台恢复上架再回滚。
ALTER TABLE "billing_model_prices" DROP COLUMN IF EXISTS "paused_at";
ALTER TABLE "billing_model_prices" DROP COLUMN IF EXISTS "pause_reason";
