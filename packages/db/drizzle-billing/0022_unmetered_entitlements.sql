CREATE TABLE IF NOT EXISTS "billing_unmetered_entitlements" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "daily_quota" integer NOT NULL DEFAULT 20 CHECK ("daily_quota" > 0),
  "guaranteed_concurrency" integer NOT NULL DEFAULT 2 CHECK ("guaranteed_concurrency" > 0),
  "idle_concurrency" integer NOT NULL DEFAULT 0 CHECK ("idle_concurrency" >= 0),
  "enabled" boolean NOT NULL DEFAULT true,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_unmetered_quota" (
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "date" text NOT NULL,
  "units" integer NOT NULL DEFAULT 0 CHECK ("units" >= 0),
  CONSTRAINT "billing_unmetered_quota_pkey" PRIMARY KEY ("user_id", "date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_billing_unmetered_quota_date" ON "billing_unmetered_quota" ("date");
