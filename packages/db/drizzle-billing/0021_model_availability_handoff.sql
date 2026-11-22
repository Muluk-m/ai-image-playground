-- 上下架交给公开库的 model_availability：单价表里停用（含自动暂停）的模型原样搬过去，公开库已有记录的以它为准。
-- 搬完单价表一律视为上架；active / pause_reason / paused_at 三列留着不读不写，等确认稳定后再删。
INSERT INTO "model_availability" ("model", "active", "pause_reason", "paused_at", "updated_at")
SELECT "model", false, "pause_reason", "paused_at", "updated_at"
FROM "billing_model_prices"
WHERE "active" = false
ON CONFLICT ("model") DO NOTHING;
--> statement-breakpoint
UPDATE "billing_model_prices"
SET "active" = true, "pause_reason" = NULL, "paused_at" = NULL
WHERE "active" = false OR "pause_reason" IS NOT NULL;
