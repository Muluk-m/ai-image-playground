-- 回滚 0104_tasks_reconciling_index.sql：移除 tasks 自动对账与超时告警局部索引。
DROP INDEX IF EXISTS "idx_tasks_reconciling_next_retry";
DROP INDEX IF EXISTS "idx_tasks_reconciling_alert";
