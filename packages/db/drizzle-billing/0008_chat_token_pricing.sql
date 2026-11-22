ALTER TABLE "billing_model_prices"
  DROP CONSTRAINT IF EXISTS "billing_model_prices_unit_check";
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  ADD CONSTRAINT "billing_model_prices_unit_check" CHECK ("unit" IN ('image', 'second', 'kilo_token'));
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  ADD COLUMN IF NOT EXISTS "output_credits_per_unit" integer CHECK ("output_credits_per_unit" > 0);
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  ADD COLUMN IF NOT EXISTS "output_reserve_tokens" integer CHECK ("output_reserve_tokens" > 0);
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  DROP CONSTRAINT IF EXISTS "billing_model_prices_chat_pricing_check";
--> statement-breakpoint
ALTER TABLE "billing_model_prices"
  ADD CONSTRAINT "billing_model_prices_chat_pricing_check"
  CHECK ("unit" <> 'kilo_token' OR ("output_credits_per_unit" IS NOT NULL AND "output_reserve_tokens" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "billing_task_holds"
  ADD COLUMN IF NOT EXISTS "input_tokens" integer CHECK ("input_tokens" >= 0);
--> statement-breakpoint
ALTER TABLE "billing_task_holds"
  ADD COLUMN IF NOT EXISTS "output_tokens" integer CHECK ("output_tokens" >= 0);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_task_holds_settled_user"
  ON "billing_task_holds" ("user_id") WHERE "status" = 'committed';
