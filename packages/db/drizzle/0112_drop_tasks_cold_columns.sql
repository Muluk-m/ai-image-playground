-- ADR 0034 Contract Wave 2 / Contract 1b：物理删除 public.tasks 上已退场的 5 个冷载荷列
-- 及 0106/0110 滚发兼容桥接触发器与函数。
-- 前提：生产已完成 backfill-task-payloads.ts 零差异验收，且 Wave 1（#2035 / Contract 1a / 0110）
-- 已全量上线并排空，线上代码与 queue_tasks 视图均已停止读写这 5 个冷列，tasks.device_id 也已解耦为普通 text 列。
-- 1. 在 lock_timeout = '5s' 保护下移除 0106/0110 的 7 个兼容触发器与 3 个触发器函数；
-- 2. 单条 ALTER TABLE 元数据级 DROP COLUMN 删除 5 个冷列（PostgreSQL 仅更新系统目录，不重写表）。
-- 回滚见 drizzle/rollback/0112_drop_tasks_cold_columns.down.sql。

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_sync_request_payload ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_sync_metering ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_sync_result_payload ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_sync_archive_payload ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_sync_upstream_body ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_fill_device_id_legacy ON public.tasks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_task_payloads_skip_legacy_null_insert ON public.task_payloads;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.sync_task_payload_column_from_tasks_update();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.fill_task_device_id_from_legacy_request();
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.skip_legacy_empty_patch_task_payload_insert();
--> statement-breakpoint
ALTER TABLE "public"."tasks"
  DROP COLUMN IF EXISTS "request_payload",
  DROP COLUMN IF EXISTS "metering",
  DROP COLUMN IF EXISTS "result_payload",
  DROP COLUMN IF EXISTS "archive_payload",
  DROP COLUMN IF EXISTS "upstream_body";
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
