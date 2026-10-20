ALTER TABLE "tasks" ADD COLUMN "reconcile_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reconcile_alerted_at" timestamp with time zone;--> statement-breakpoint
-- 旧行把进入结果确认的时刻记在 next_retry_at 上。先抄出来，再把下次核对拨到 5 分钟之后，
-- 与「进入后再等 5 分钟」的原谓词对齐，避免上线当刻把积压一次性打到上游。
UPDATE "tasks"
SET "reconcile_started_at" = "next_retry_at"
WHERE "status" = 'reconciling' AND "reconcile_started_at" IS NULL;--> statement-breakpoint
UPDATE "tasks"
SET "next_retry_at" = "next_retry_at" + interval '5 minutes'
WHERE "status" = 'reconciling' AND "next_retry_at" IS NOT NULL;
