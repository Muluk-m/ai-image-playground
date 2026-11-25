-- 回滚 0112_drop_tasks_cold_columns.sql：
-- 1. 恢复 public.tasks 的 5 个可空冷载荷列（与 0110 状态一致）；
-- 2. 在重建触发器前先将 public.task_payloads 权威值幂等回同步至 public.tasks；
-- 3. 重建 0110 的 3 个桥接触发器函数与 7 个触发器，确保后续若需继续回滚 0110/0106 链路畅通。

ALTER TABLE "public"."tasks"
  ADD COLUMN IF NOT EXISTS "request_payload" jsonb,
  ADD COLUMN IF NOT EXISTS "metering" jsonb,
  ADD COLUMN IF NOT EXISTS "result_payload" jsonb,
  ADD COLUMN IF NOT EXISTS "archive_payload" jsonb,
  ADD COLUMN IF NOT EXISTS "upstream_body" text;
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.skip_legacy_empty_patch_task_payload_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.task_payloads WHERE task_id = NEW.task_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER trg_task_payloads_skip_legacy_null_insert
BEFORE INSERT
ON public.task_payloads
FOR EACH ROW
WHEN (NEW.request_payload IS NULL)
EXECUTE FUNCTION public.skip_legacy_empty_patch_task_payload_insert();
