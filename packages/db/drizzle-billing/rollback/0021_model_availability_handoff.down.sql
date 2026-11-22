-- 退回旧版收费模块前把公开库里停用的模型抄回单价表，旧代码只认这里。
UPDATE "billing_model_prices" AS p
SET "active" = false, "pause_reason" = a."pause_reason", "paused_at" = a."paused_at"
FROM "model_availability" AS a
WHERE a."model" = p."model" AND a."active" = false;
