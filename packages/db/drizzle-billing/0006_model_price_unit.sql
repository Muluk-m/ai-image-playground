ALTER TABLE "billing_model_prices"
  ADD COLUMN IF NOT EXISTS "unit" text NOT NULL DEFAULT 'image';
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  DROP CONSTRAINT IF EXISTS "billing_model_prices_unit_check";
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  ADD CONSTRAINT "billing_model_prices_unit_check" CHECK ("unit" IN ('image', 'second'));
