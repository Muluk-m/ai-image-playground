CREATE TABLE "billing_referral_policy" (
  "id" text PRIMARY KEY CHECK ("id" = 'default'),
  "inviter_registration_credits" integer NOT NULL CHECK ("inviter_registration_credits" >= 0),
  "invitee_registration_credits" integer NOT NULL CHECK ("invitee_registration_credits" >= 0),
  "paid_reward_basis_points" integer NOT NULL CHECK ("paid_reward_basis_points" BETWEEN 0 AND 10000),
  "credits_per_yuan_scaled" bigint NOT NULL CHECK ("credits_per_yuan_scaled" BETWEEN 1 AND 21474836470000),
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "billing_referral_policy" VALUES ('default', 200, 200, 500, 1000000, NOW());
--> statement-breakpoint
CREATE TABLE "billing_referral_profiles" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "code" text NOT NULL UNIQUE,
  "reward_balance" integer NOT NULL DEFAULT 0 CHECK ("reward_balance" >= 0),
  "total_rewards" bigint NOT NULL DEFAULT 0 CHECK ("total_rewards" BETWEEN 0 AND 9007199254740991),
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_referral_relationships" (
  "user_id" text PRIMARY KEY REFERENCES "users"("id"),
  "inviter_user_id" text NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL,
  CHECK ("user_id" <> "inviter_user_id")
);
--> statement-breakpoint
CREATE INDEX "idx_billing_referrals_inviter" ON "billing_referral_relationships"("inviter_user_id");
--> statement-breakpoint
CREATE TABLE "billing_referral_transfers" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "credits" integer NOT NULL CHECK ("credits" > 0),
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_referral_rewards" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "kind" text NOT NULL CHECK ("kind" IN ('registration_inviter', 'registration_invitee', 'payment')),
  "source_id" text NOT NULL,
  "credits" integer NOT NULL CHECK ("credits" > 0),
  "transfer_id" text REFERENCES "billing_referral_transfers"("id"),
  "created_at" timestamp with time zone NOT NULL,
  CHECK ("transfer_id" IS NULL OR "kind" = 'payment')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_billing_reward_source" ON "billing_referral_rewards"("user_id", "kind", "source_id");
--> statement-breakpoint
CREATE INDEX "idx_billing_rewards_user_time" ON "billing_referral_rewards"("user_id", "created_at" DESC, "id" DESC);
--> statement-breakpoint
ALTER TABLE "billing_confirmed_payments"
  ADD COLUMN "inviter_user_id" text REFERENCES "users"("id"),
  ADD COLUMN "paid_reward_basis_points" integer CHECK ("paid_reward_basis_points" BETWEEN 0 AND 10000),
  ADD COLUMN "credits_per_yuan_scaled" bigint CHECK ("credits_per_yuan_scaled" BETWEEN 1 AND 21474836470000),
  ADD COLUMN "reward_credits" integer CHECK ("reward_credits" >= 0);
