-- 回滚 0105_task_payloads.sql：移除 task_payloads 冷表（tasks 原有列保留，不影响读写）。
DROP TABLE IF EXISTS "task_payloads";
