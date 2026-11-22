CREATE TABLE "billing_confirmed_payments" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('recharge', 'subscription')),
  "amount_cents" integer NOT NULL CHECK ("amount_cents" > 0),
  "request_hash" text NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "operator_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_billing_payments_user_time" ON "billing_confirmed_payments" ("user_id", "created_at" DESC);
