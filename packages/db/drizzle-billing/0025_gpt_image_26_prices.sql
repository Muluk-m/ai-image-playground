-- GPT Image 2.6 直连的两个模型（公开仓 #1679）。公开侧倍率是「公布积分 ÷ 100」，
-- 基准单价与 2.5 Flare 1K 标准一样登记成 100 积分/张。运营之后在后台调；已有的价格与启用状态一律不动。
INSERT INTO "billing_model_prices" ("model", "credits_per_image", "unit", "active", "updated_at") VALUES
  ('gpt-image-2.6-flare', 100, 'image', true, NOW()),
  ('gpt-image-2.6-sunburst', 100, 'image', true, NOW())
ON CONFLICT ("model") DO NOTHING;
