-- 回滚 0101_cli_connection_user_agent.sql：移除 cli_connections.user_agent 可空列。
ALTER TABLE "cli_connections" DROP COLUMN IF EXISTS "user_agent";
