ALTER TABLE "billing_model_prices"
  DROP CONSTRAINT IF EXISTS "billing_model_prices_unit_check";
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  DROP COLUMN IF EXISTS "unit";
