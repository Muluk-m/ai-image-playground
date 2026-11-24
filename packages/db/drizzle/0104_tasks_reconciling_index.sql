-- 支持自动对账扫描与 30 分钟超时告警直接命中 reconciling 队列任务局部索引，
-- 避免扫描宽泛的 idx_tasks_next_retry_at / idx_tasks_status_submitted 并过滤历史终态行。
-- 注意：查询条件允许 next_retry_at IS NULL / reconcile_started_at IS NULL，
-- 故谓词不附加 IS NOT NULL，确保 PostgreSQL 规划器可直接使用部分索引。
-- 在线升级时由 packages/db/src/migrate.ts 在事务外通过 CREATE INDEX CONCURRENTLY 预先构建；
-- 此处先检查 pg_index.indisvalid，已有有效索引时直接跳过（不对 tasks 申请 SHARE 锁），
-- 仅在全新空库或脱离 runMigrations 执行时走事务内建索引兜底。
-- 回滚见 drizzle/rollback/0104_tasks_reconciling_index.down.sql。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_tasks_reconciling_next_retry'
      AND i.indisvalid
  ) THEN
    DROP INDEX IF EXISTS "idx_tasks_reconciling_next_retry";
    CREATE INDEX "idx_tasks_reconciling_next_retry" ON "tasks" USING btree ("next_retry_at","id") WHERE "kind" = 'queue' AND "status" = 'reconciling';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_tasks_reconciling_alert'
      AND i.indisvalid
  ) THEN
    DROP INDEX IF EXISTS "idx_tasks_reconciling_alert";
    CREATE INDEX "idx_tasks_reconciling_alert" ON "tasks" USING btree ("reconcile_started_at","id") WHERE "kind" = 'queue' AND "status" = 'reconciling' AND "reconcile_alerted_at" IS NULL;
  END IF;
END $$;
