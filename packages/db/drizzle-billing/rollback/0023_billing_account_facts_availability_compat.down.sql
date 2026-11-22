-- Restore the legacy worker's source of truth before removing the bridge.
UPDATE "billing_model_prices" p
SET "active" = a."active",
    "pause_reason" = a."pause_reason",
    "paused_at" = a."paused_at",
    "updated_at" = a."updated_at"
FROM "model_availability" a
WHERE a."model" = p."model";
--> statement-breakpoint
DROP TABLE IF EXISTS "billing_account_facts";
