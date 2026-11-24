-- Phase 5 / PR-5.2（Expand）：拆分 tasks 表 5 个大体积冷载荷列至独立 1:1 冷表 task_payloads，
-- 避免 Worker 心跳续租、认领、状态流转等高频热路径写操作触发整行 MVCC 复制。
-- 本阶段为纯追加建表；tasks 原有 5 列完整保留，兼容新旧实例并存滚动发布。
-- 回滚见 drizzle/rollback/0105_task_payloads.down.sql。
CREATE TABLE IF NOT EXISTS "task_payloads" (
	"task_id" text PRIMARY KEY NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"request_payload" jsonb NOT NULL,
	"metering" jsonb,
	"result_payload" jsonb,
	"archive_payload" jsonb,
	"upstream_body" text
);
