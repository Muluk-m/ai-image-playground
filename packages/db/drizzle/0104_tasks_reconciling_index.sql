-- 支持自动对账扫描与 30 分钟超时告警直接命中 reconciling 队列任务局部索引，
-- 避免扫描宽泛的 idx_tasks_next_retry_at / idx_tasks_status_submitted 并过滤历史终态行。
-- 注意：查询条件允许 next_retry_at IS NULL / reconcile_started_at IS NULL，
-- 故谓词不附加 IS NOT NULL，确保 PostgreSQL 规划器可直接使用部分索引。
-- 回滚见 drizzle/rollback/0104_tasks_reconciling_index.down.sql。
CREATE INDEX IF NOT EXISTS "idx_tasks_reconciling_next_retry" ON "tasks" USING btree ("next_retry_at","id") WHERE "kind" = 'queue' AND "status" = 'reconciling';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_reconciling_alert" ON "tasks" USING btree ("reconcile_started_at","id") WHERE "kind" = 'queue' AND "status" = 'reconciling' AND "reconcile_alerted_at" IS NULL;
