-- ADR 0033 P3-6 / ADR 0034 Phase 6 Contract 3:
-- 服务端日志已全量迁至 OpenObserve，BFF / worker / Admin 运行时均不再读写 PG server_logs 表。
-- 回滚见 drizzle/rollback/0109_drop_server_logs.down.sql。
DROP TABLE IF EXISTS "server_logs";
