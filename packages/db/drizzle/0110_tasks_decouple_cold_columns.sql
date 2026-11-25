-- ADR 0034 Contract Wave 1 / Contract 1a：
-- 解除 tasks.device_id 对 tasks.request_payload 的生成列依赖，并放松 tasks.request_payload NOT NULL，
-- 使 Wave 1 新代码停止读写 tasks 的 5 个冷载荷列，全部切到 task_payloads。
-- 1. 元数据级 ALTER（无表重写）：保留 5 个冷列供滚发期间未排空及回滚时的 v0.4.481 继续工作；
-- 2. 新增 BEFORE INSERT OR UPDATE OF request_payload 桥接触发器，确保旧版写入方不传 device_id 时
--    仍能自动填充 tasks.device_id；
-- 3. 升级 0106 按列同步触发器函数为先 UPDATE 已存在的 task_payloads 行，避免旧版容器更新 Wave 1
--    任务（tasks.request_payload 为 NULL）时走 INSERT ... ON CONFLICT 提前撞上 NOT NULL 约束；
-- 4. 将 public.queue_tasks 视图切为直接读取 task_payloads（移除 ELSE t.<col> 回落，保留精确列序与既有授权），
--    使 Wave 1 线上零引用 tasks 5 个冷列，确保 Wave 2 删列零停机且可回滚到 Wave 1。
-- 回滚见 drizzle/rollback/0110_tasks_decouple_cold_columns.down.sql。

ALTER TABLE "public"."tasks" ALTER COLUMN "device_id" DROP EXPRESSION;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ALTER COLUMN "request_payload" DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.fill_task_device_id_from_legacy_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.device_id IS NULL AND NEW.request_payload IS NOT NULL THEN
      NEW.device_id := NEW.request_payload ->> 'device_id';
    END IF;
  ELSIF NEW.device_id IS NOT DISTINCT FROM OLD.device_id AND NEW.request_payload IS NOT NULL THEN
    NEW.device_id := NEW.request_payload ->> 'device_id';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_tasks_fill_device_id_legacy
BEFORE INSERT OR UPDATE OF request_payload
ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.fill_task_device_id_from_legacy_request();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sync_task_payload_column_from_tasks_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_col text := TG_ARGV[0];
BEGIN
  IF target_col = 'request_payload' THEN
    IF NEW.request_payload IS NOT NULL THEN
      INSERT INTO public.task_payloads (
        task_id, request_payload, metering, result_payload, archive_payload, upstream_body
      )
      VALUES (
        NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
      )
      ON CONFLICT (task_id) DO UPDATE SET
        request_payload = EXCLUDED.request_payload
      WHERE public.task_payloads.request_payload IS DISTINCT FROM EXCLUDED.request_payload;
    END IF;
  ELSIF target_col = 'metering' THEN
    UPDATE public.task_payloads
    SET metering = NEW.metering
    WHERE task_id = NEW.id
      AND metering IS DISTINCT FROM NEW.metering;
    IF NOT FOUND AND NEW.request_payload IS NOT NULL THEN
      INSERT INTO public.task_payloads (
        task_id, request_payload, metering, result_payload, archive_payload, upstream_body
      )
      VALUES (
        NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
      )
      ON CONFLICT (task_id) DO UPDATE SET
        metering = EXCLUDED.metering
      WHERE public.task_payloads.metering IS DISTINCT FROM EXCLUDED.metering;
    END IF;
  ELSIF target_col = 'result_payload' THEN
    UPDATE public.task_payloads
    SET result_payload = NEW.result_payload
    WHERE task_id = NEW.id
      AND result_payload IS DISTINCT FROM NEW.result_payload;
    IF NOT FOUND AND NEW.request_payload IS NOT NULL THEN
      INSERT INTO public.task_payloads (
        task_id, request_payload, metering, result_payload, archive_payload, upstream_body
      )
      VALUES (
        NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
      )
      ON CONFLICT (task_id) DO UPDATE SET
        result_payload = EXCLUDED.result_payload
      WHERE public.task_payloads.result_payload IS DISTINCT FROM EXCLUDED.result_payload;
    END IF;
  ELSIF target_col = 'archive_payload' THEN
    UPDATE public.task_payloads
    SET archive_payload = NEW.archive_payload
    WHERE task_id = NEW.id
      AND archive_payload IS DISTINCT FROM NEW.archive_payload;
    IF NOT FOUND AND NEW.request_payload IS NOT NULL THEN
      INSERT INTO public.task_payloads (
        task_id, request_payload, metering, result_payload, archive_payload, upstream_body
      )
      VALUES (
        NEW.id, NEW.request_payload, NEW.metering, NEW.result_payload, NEW.archive_payload, NEW.upstream_body
      )
      ON CONFLICT (task_id) DO UPDATE SET
        archive_payload = EXCLUDED.archive_payload
      WHERE public.task_payloads.archive_payload IS DISTINCT FROM EXCLUDED.archive_payload;
    END IF;
  ELSIF target_col = 'upstream_body' THEN
    UPDATE public.task_payloads
    SET upstream_body = NEW.upstream_body
    WHERE task_id = NEW.id
      AND upstream_body IS DISTINCT FROM NEW.upstream_body;
    IF NOT FOUND AND NEW.request_payload IS NOT NULL THEN
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
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(
    CASE attname
      WHEN 'request_payload' THEN 'p.request_payload AS request_payload'
      WHEN 'result_payload' THEN 'p.result_payload AS result_payload'
      WHEN 'upstream_body' THEN 'p.upstream_body AS upstream_body'
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
