-- Existing deployments did not settle cache reads; preserve that until an operator sets a price.
ALTER TABLE "billing_model_prices" ADD COLUMN "cached_input_price_percent" integer NOT NULL DEFAULT 0
  CHECK ("cached_input_price_percent" BETWEEN 0 AND 100);
--> statement-breakpoint
ALTER TABLE "billing_task_holds" ADD COLUMN "cached_input_tokens" integer
  CHECK ("cached_input_tokens" >= 0 AND "cached_input_tokens" <= "input_tokens");
