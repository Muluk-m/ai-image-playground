INSERT INTO "billing_model_prices" ("model", "credits_per_image", "active", "updated_at") VALUES
  ('grok-imagine-image', 100, true, NOW()),
  ('grok-imagine-image-2.0', 100, true, NOW())
ON CONFLICT ("model") DO NOTHING;
