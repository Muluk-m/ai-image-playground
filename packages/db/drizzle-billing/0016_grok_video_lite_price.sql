-- 只初始化新模型，保留运营已设置的每秒单价和启用状态。
INSERT INTO "billing_model_prices" ("model", "credits_per_image", "unit", "active", "updated_at")
SELECT 'grok-imagine-video-1.5-lite', "credits_per_image", 'second', "active", NOW()
FROM "billing_model_prices"
WHERE "model" = 'grok-imagine-video'
ON CONFLICT ("model") DO NOTHING;
