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
-- 同事务自动把本次实际发生变化的列同步到 task_payloads（未改动列保留 task_payloads 原值，避免局部更新覆写）。
-- 仅在冷载荷列发生实际变化时触发，热路径续租/认领/取消/重排零开销；使用 CREATE OR REPLACE TRIGGER
-- 仅获取 SHARE ROW EXCLUSIVE 锁，不阻塞 tasks 上的读请求与 pg_dump。
CREATE OR REPLACE FUNCTION public.sync_task_payloads_from_tasks_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.task_payloads (
    task_id, request_payload, metering, result_payload, archive_payload, upstream_body
  )
  VALUES (
    NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
  )
  ON CONFLICT (task_id) DO UPDATE SET
    request_payload = CASE
      WHEN OLD.request_payload IS DISTINCT FROM NEW.request_payload THEN EXCLUDED.request_payload
      ELSE public.task_payloads.request_payload
    END,
    metering = CASE
      WHEN OLD.metering IS DISTINCT FROM NEW.metering THEN EXCLUDED.metering
      ELSE public.task_payloads.metering
    END,
    result_payload = CASE
      WHEN OLD.result_payload IS DISTINCT FROM NEW.result_payload THEN EXCLUDED.result_payload
      ELSE public.task_payloads.result_payload
    END,
    archive_payload = CASE
      WHEN OLD.archive_payload IS DISTINCT FROM NEW.archive_payload THEN EXCLUDED.archive_payload
      ELSE public.task_payloads.archive_payload
    END,
    upstream_body = CASE
      WHEN OLD.upstream_body IS DISTINCT FROM NEW.upstream_body THEN EXCLUDED.upstream_body
      ELSE public.task_payloads.upstream_body
    END
  WHERE
    (OLD.request_payload IS DISTINCT FROM NEW.request_payload AND public.task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload)
    OR (OLD.metering IS DISTINCT FROM NEW.metering AND public.task_payloads.metering IS DISTINCT FROM EXCLUDED.metering)
    OR (OLD.result_payload IS DISTINCT FROM NEW.result_payload AND public.task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload)
    OR (OLD.archive_payload IS DISTINCT FROM NEW.archive_payload AND public.task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload)
    OR (OLD.upstream_body IS DISTINCT FROM NEW.upstream_body AND public.task_payloads.upstream_body IS DISTINCT FROM EXCLUDED.upstream_body);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_sync_payloads_on_update
AFTER UPDATE OF request_payload, metering, result_payload, archive_payload, upstream_body
ON public.tasks
FOR EACH ROW
WHEN (
  OLD.request_payload IS DISTINCT FROM NEW.request_payload
  OR OLD.metering IS DISTINCT FROM NEW.metering
  OR OLD.result_payload IS DISTINCT FROM NEW.result_payload
  OR OLD.archive_payload IS DISTINCT FROM NEW.archive_payload
  OR OLD.upstream_body IS DISTINCT FROM NEW.upstream_body
)
EXECUTE FUNCTION public.sync_task_payloads_from_tasks_update();
