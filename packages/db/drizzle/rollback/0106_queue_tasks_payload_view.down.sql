-- 回滚 0106_queue_tasks_payload_view.sql：卸载按列冷载荷同步触发器与函数，
-- 把 task_payloads 中较新的权威值回同步到 public.tasks（仅写存在差异的行，保留缺行旧任务），
-- 再恢复 queue_tasks 视图直接从 public.tasks 读取全部列。
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
DROP FUNCTION IF EXISTS public.sync_task_payload_column_from_tasks_update();
--> statement-breakpoint
UPDATE public.tasks t
SET
  request_payload = p.request_payload,
  metering = p.metering,
  result_payload = p.result_payload,
  archive_payload = p.archive_payload,
  upstream_body = p.upstream_body
FROM public.task_payloads p
WHERE p.task_id = t.id
  AND (
    t.request_payload IS DISTINCT FROM p.request_payload
    OR t.metering IS DISTINCT FROM p.metering
    OR t.result_payload IS DISTINCT FROM p.result_payload
    OR t.archive_payload IS DISTINCT FROM p.archive_payload
    OR t.upstream_body IS DISTINCT FROM p.upstream_body
  );
--> statement-breakpoint
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(format('t.%I', attname), ', ' ORDER BY attnum) INTO columns_sql
  FROM pg_attribute
  WHERE attrelid = 'public.queue_tasks'::regclass AND attnum > 0 AND NOT attisdropped;

  EXECUTE format(
    'CREATE OR REPLACE VIEW public.queue_tasks AS SELECT %s FROM public.tasks t WHERE t.kind = %L',
    columns_sql,
    'queue'
  );
END $$;
