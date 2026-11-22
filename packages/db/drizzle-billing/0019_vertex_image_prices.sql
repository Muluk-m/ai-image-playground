-- Vertex AI 直连的三个 Gemini 图像模型。渠道只在配了 VERTEX_API_KEY 与 VERTEX_BASE_URL 的部署里出现，
-- 单价按产品拍板的 100 / 150 / 80 积分定，运营之后在后台调；已有的价格与启用状态一律不动。
INSERT INTO "billing_model_prices" ("model", "credits_per_image", "unit", "active", "updated_at") VALUES
  ('gemini-nano-banana-2.1', 100, 'image', true, NOW()),
  ('gemini-3-pro-image', 150, 'image', true, NOW()),
  ('gemini-3.1-flash-lite-image', 80, 'image', true, NOW())
ON CONFLICT ("model") DO NOTHING;
