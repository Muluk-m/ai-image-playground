-- 支持按活跃 CLI 连接快速聚合生成次数，避免 `/api/me/cli-connections` 轮询扫描整张 cli_jobs。
CREATE INDEX IF NOT EXISTS "idx_cli_jobs_connection_id" ON "cli_jobs" ("connection_id") WHERE "connection_id" IS NOT NULL;
