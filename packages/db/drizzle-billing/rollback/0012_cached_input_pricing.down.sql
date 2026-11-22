ALTER TABLE "billing_task_holds" DROP COLUMN IF EXISTS "cached_input_tokens";
ALTER TABLE "billing_model_prices" DROP COLUMN IF EXISTS "cached_input_price_percent";
