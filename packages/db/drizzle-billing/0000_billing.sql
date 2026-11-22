CREATE TABLE IF NOT EXISTS "billing_model_prices" (
  "model" text PRIMARY KEY NOT NULL,
  "credits_per_image" integer NOT NULL CHECK ("credits_per_image" > 0),
  "active" boolean DEFAULT true NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_plans" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "monthly_credits" integer NOT NULL CHECK ("monthly_credits" > 0),
  "active" boolean DEFAULT true NOT NULL,
  "sort_order" integer NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_plan_prices" (
  "plan_id" text NOT NULL REFERENCES "billing_plans"("id"),
  "period_months" integer NOT NULL CHECK ("period_months" IN (1, 3, 12)),
  "original_price_cents" integer NOT NULL CHECK ("original_price_cents" >= 0),
  "discount_price_cents" integer CHECK ("discount_price_cents" >= 0),
  "discount_ends_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "billing_plan_prices_plan_id_period_months_pk" PRIMARY KEY("plan_id", "period_months")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_settings" (
  "id" text PRIMARY KEY NOT NULL,
  "contact_wechat" text DEFAULT '' NOT NULL,
  "payment_qr_url" text DEFAULT '' NOT NULL,
  "guidance" text DEFAULT '联系客服完成转账后，请发送用户名与付款截图。' NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_credit_accounts" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id"),
  "subscription_balance" integer DEFAULT 0 NOT NULL CHECK ("subscription_balance" >= 0),
  "recharge_balance" integer DEFAULT 0 NOT NULL CHECK ("recharge_balance" >= 0),
  "subscription_expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "plan_id" text NOT NULL REFERENCES "billing_plans"("id"),
  "period_months" integer NOT NULL CHECK ("period_months" IN (1, 3, 12)),
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "next_grant_at" timestamp with time zone,
  "status" text NOT NULL CHECK ("status" IN ('active', 'expired')),
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_subscriptions_user" ON "billing_subscriptions" ("user_id", "ends_at" DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_billing_subscriptions_active_user" ON "billing_subscriptions" ("user_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_task_holds" (
  "task_id" text PRIMARY KEY NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "subscription_amount" integer NOT NULL CHECK ("subscription_amount" >= 0),
  "recharge_amount" integer NOT NULL CHECK ("recharge_amount" >= 0),
  "total_amount" integer NOT NULL CHECK ("total_amount" > 0),
  "model" text NOT NULL,
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "status" text NOT NULL CHECK ("status" IN ('held', 'committed', 'released')),
  "created_at" timestamp with time zone NOT NULL,
  "settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_credit_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "bucket" text NOT NULL CHECK ("bucket" IN ('subscription', 'recharge')),
  "entry_type" text NOT NULL CHECK ("entry_type" IN ('grant', 'recharge', 'hold', 'commit', 'release', 'expire', 'adjustment')),
  "amount" integer NOT NULL,
  "task_id" text,
  "reference_id" text,
  "model" text,
  "quantity" integer,
  "operator_id" text,
  "note" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_ledger_user_time" ON "billing_credit_ledger" ("user_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_ledger_task" ON "billing_credit_ledger" ("task_id");
--> statement-breakpoint
INSERT INTO "billing_model_prices" ("model", "credits_per_image", "active", "updated_at") VALUES
  ('gpt-image-2', 100, true, NOW()),
  ('gemini-3.1-flash-image', 25, true, NOW()),
  ('agnes-image-2.1-flash', 100, true, NOW())
ON CONFLICT ("model") DO NOTHING;
--> statement-breakpoint
INSERT INTO "billing_plans" ("id", "name", "monthly_credits", "active", "sort_order", "updated_at") VALUES
  ('starter', '入门', 66000, true, 10, NOW()),
  ('standard', '标准', 220000, true, 20, NOW()),
  ('professional', '专业', 600000, true, 30, NOW())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "billing_plan_prices" ("plan_id", "period_months", "original_price_cents", "discount_price_cents", "discount_ends_at", "updated_at") VALUES
  ('starter', 1, 4900, 3900, '2026-09-01T00:00:00Z', NOW()),
  ('starter', 3, 14700, NULL, NULL, NOW()),
  ('starter', 12, 58800, NULL, NULL, NOW()),
  ('standard', 1, 12900, NULL, NULL, NOW()),
  ('standard', 3, 38700, NULL, NULL, NOW()),
  ('standard', 12, 154800, NULL, NULL, NOW()),
  ('professional', 1, 29900, NULL, NULL, NOW()),
  ('professional', 3, 89700, NULL, NULL, NOW()),
  ('professional', 12, 358800, NULL, NULL, NOW())
ON CONFLICT ("plan_id", "period_months") DO NOTHING;
--> statement-breakpoint
INSERT INTO "billing_settings" ("id", "updated_at") VALUES ('default', NOW()) ON CONFLICT ("id") DO NOTHING;
