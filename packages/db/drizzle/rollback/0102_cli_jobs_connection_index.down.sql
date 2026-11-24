-- 回滚 0102_cli_jobs_connection_index.sql：移除 cli_jobs.connection_id 局部索引。
DROP INDEX IF EXISTS "idx_cli_jobs_connection_id";
