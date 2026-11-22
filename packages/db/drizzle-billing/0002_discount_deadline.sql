UPDATE "billing_plan_prices"
SET "discount_price_cents" = NULL
WHERE "discount_price_cents" IS NOT NULL
  AND "discount_ends_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "billing_plan_prices"
ADD CONSTRAINT "billing_plan_prices_discount_deadline"
CHECK ("discount_price_cents" IS NULL OR "discount_ends_at" IS NOT NULL);
