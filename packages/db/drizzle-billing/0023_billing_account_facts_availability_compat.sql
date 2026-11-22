-- Persist billing account category independently of OAuth identities. Existing
-- unmetered users are the authoritative backfill for Feishu's durable category.
CREATE TABLE IF NOT EXISTS "billing_account_facts" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category" text NOT NULL CHECK ("category" IN ('feishu_unmetered')),
  "created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
INSERT INTO "billing_account_facts" ("user_id", "category", "created_at")
SELECT "user_id", 'feishu_unmetered', "updated_at"
FROM "billing_unmetered_entitlements"
ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
-- During the handoff, old workers may still toggle billing_model_prices.active.
-- Reconcile only rows that have no explicit public availability decision: public
-- availability remains authoritative whenever it has a row.
INSERT INTO "model_availability" ("model", "active", "pause_reason", "paused_at", "updated_at")
SELECT p."model", p."active", p."pause_reason", p."paused_at", p."updated_at"
FROM "billing_model_prices" p
WHERE NOT EXISTS (
  SELECT 1 FROM "model_availability" a WHERE a."model" = p."model"
)
ON CONFLICT ("model") DO NOTHING;
--> statement-breakpoint
-- Restore the post-handoff invariant for old workers: all price rows are active;
-- inactive state is retained in model_availability and is read there by new code.
UPDATE "billing_model_prices" p
SET "active" = true, "pause_reason" = NULL, "paused_at" = NULL
WHERE EXISTS (
  SELECT 1 FROM "model_availability" a
  WHERE a."model" = p."model" AND a."active" = true
)
  AND (p."active" = false OR p."pause_reason" IS NOT NULL OR p."paused_at" IS NOT NULL);
