ALTER TABLE "billing_task_holds"
  ADD COLUMN IF NOT EXISTS "net_spend" integer CHECK ("net_spend" >= 0);
--> statement-breakpoint
UPDATE "billing_task_holds" AS h SET "net_spend" = GREATEST(h."total_amount" - r."released", 0)
  FROM (
    SELECT "task_id", SUM("amount") AS "released"
      FROM "billing_credit_ledger" WHERE "entry_type" = 'release' GROUP BY "task_id"
  ) AS r
  WHERE h."status" <> 'held' AND h."task_id" = r."task_id";
--> statement-breakpoint
UPDATE "billing_task_holds" SET "net_spend" = "total_amount"
  WHERE "status" <> 'held' AND "net_spend" IS NULL;
