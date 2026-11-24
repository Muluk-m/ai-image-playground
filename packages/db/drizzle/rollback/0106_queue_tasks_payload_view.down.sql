-- 回滚 0106_queue_tasks_payload_view.sql：卸载冷载荷同步触发器并恢复 queue_tasks 视图直接从 public.tasks 读取全部列。
DROP TRIGGER IF EXISTS trg_tasks_sync_payloads_on_update ON public.tasks;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.sync_task_payloads_from_tasks_update();
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
