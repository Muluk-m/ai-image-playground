-- Phase 5 / PR-5.3a（Switch-Read）：将 queue_tasks 视图中的 3 个冷载荷列
-- （request_payload / result_payload / upstream_body）切为优先读取 task_payloads，
-- 尚未回填的旧行回落到 tasks 原列；按现有 pg_attribute 顺序保留全部列定义与既有授权。
-- 因 task_payloads.task_id 是主键，仅读热列的查询会自动触发 PostgreSQL LEFT JOIN 消除。
-- 回滚见 drizzle/rollback/0106_queue_tasks_payload_view.down.sql。
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(
    CASE attname
      WHEN 'request_payload' THEN 'CASE WHEN p.task_id IS NOT NULL THEN p.request_payload ELSE t.request_payload END AS request_payload'
      WHEN 'result_payload' THEN 'CASE WHEN p.task_id IS NOT NULL THEN p.result_payload ELSE t.result_payload END AS result_payload'
      WHEN 'upstream_body' THEN 'CASE WHEN p.task_id IS NOT NULL THEN p.upstream_body ELSE t.upstream_body END AS upstream_body'
      ELSE format('t.%I', attname)
    END,
    ', ' ORDER BY attnum
  ) INTO columns_sql
  FROM pg_attribute
  WHERE attrelid = 'public.queue_tasks'::regclass AND attnum > 0 AND NOT attisdropped;

  EXECUTE format(
    'CREATE OR REPLACE VIEW public.queue_tasks AS SELECT %s FROM public.tasks t LEFT JOIN public.task_payloads p ON p.task_id = t.id WHERE t.kind = %L',
    columns_sql,
    'queue'
  );
END $$;
--> statement-breakpoint
-- 滚发兜底触发器：若直跳 0105+0106 上线期间仍有未下线的旧版实例直接更新 tasks 的 5 个冷载荷列，
-- 通过 5 个按列拆分的 AFTER UPDATE OF <col> 触发器（CREATE OR REPLACE TRIGGER，仅获取 SHARE ROW EXCLUSIVE 锁，
-- 不阻塞 tasks 上的读请求与 pg_dump）精确追踪 SQL SET 子句命中的列：
-- 1. 热路径续租/认领/取消/重排完全不触碰任何触发器，零开销；
-- 2. 即使旧列原值已为 NULL、旧实例显式执行 SET <col> = NULL，也会命中该列触发器并同步清空 task_payloads 对应列；
-- 3. 局部更新只写命中的列，绝不覆写 task_payloads 中其余未改动列。
CREATE OR REPLACE FUNCTION public.sync_task_payload_column_from_tasks_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_col text := TG_ARGV[0];
BEGIN
  IF target_col = 'request_payload' THEN
    INSERT INTO public.task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    VALUES (
      NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
    )
    ON CONFLICT (task_id) DO UPDATE SET
      request_payload = EXCLUDED.request_payload
    WHERE public.task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload;
  ELSIF target_col = 'metering' THEN
    INSERT INTO public.task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    VALUES (
      NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
    )
    ON CONFLICT (task_id) DO UPDATE SET
      metering = EXCLUDED.metering
    WHERE public.task_payloads.metering IS DISTINCT FROM EXCLUDED.metering;
  ELSIF target_col = 'result_payload' THEN
    INSERT INTO public.task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    VALUES (
      NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
    )
    ON CONFLICT (task_id) DO UPDATE SET
      result_payload = EXCLUDED.result_payload
    WHERE public.task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload;
  ELSIF target_col = 'archive_payload' THEN
    INSERT INTO public.task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    VALUES (
      NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
    )
    ON CONFLICT (task_id) DO UPDATE SET
      archive_payload = EXCLUDED.archive_payload
    WHERE public.task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload;
  ELSIF target_col = 'upstream_body' THEN
    INSERT INTO public.task_payloads (
      task_id, request_payload, metering, result_payload, archive_payload, upstream_body
    )
    VALUES (
      NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
    )
    ON CONFLICT (task_id) DO UPDATE SET
      upstream_body = EXCLUDED.upstream_body
    WHERE public.task_payloads.upstream_body IS DISTINCT FROM EXCLUDED.upstream_body;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_request_payload
AFTER UPDATE OF request_payload
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.sync_task_payload_column_from_tasks_update('request_payload');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_metering
AFTER UPDATE OF metering
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.sync_task_payload_column_from_tasks_update('metering');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_result_payload
AFTER UPDATE OF result_payload
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.sync_task_payload_column_from_tasks_update('result_payload');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_archive_payload
AFTER UPDATE OF archive_payload
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.sync_task_payload_column_from_tasks_update('archive_payload');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_upstream_body
AFTER UPDATE OF upstream_body
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.sync_task_payload_column_from_tasks_update('upstream_body');
