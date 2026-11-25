-- 回滚 0110_tasks_decouple_cold_columns.sql：
-- 1. 卸载 0110 新增的旧版 device_id 与 task_payloads 空 patch 桥接触发器及函数；
-- 2. 将 task_payloads 权威值回同步到 public.tasks（并给缺冷表行的孤立行兜底 '{}'），恢复 request_payload NOT NULL；
-- 3. 保留 public.queue_tasks 原有列序、属主与既有授权，重建 tasks.device_id 为 GENERATED ALWAYS STORED 及其索引，
--    并恢复 queue_tasks 视图到 0106 的 CASE WHEN 回落定义；
-- 4. 恢复 0106 的 sync_task_payload_column_from_tasks_update() 函数体。

DROP TRIGGER IF EXISTS trg_task_payloads_skip_legacy_null_insert ON public.task_payloads;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.skip_legacy_empty_patch_task_payload_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tasks_fill_device_id_legacy ON public.tasks;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.fill_task_device_id_from_legacy_request();
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
UPDATE public.tasks
SET request_payload = '{}'::jsonb
WHERE request_payload IS NULL;
--> statement-breakpoint
ALTER TABLE "public"."tasks" ALTER COLUMN "request_payload" SET NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  columns_sql text;
  view_owner text;
  grants text[];
  statement text;
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

  SELECT pg_get_userbyid(relation.relowner) INTO view_owner
  FROM pg_class relation
  WHERE relation.oid = 'public.queue_tasks'::regclass;

  SELECT array_agg(format(
    'GRANT %s ON TABLE public.queue_tasks TO %s%s',
    acl.privilege_type,
    CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl.grantee)) END,
    CASE WHEN acl.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
  )) INTO grants
  FROM pg_class relation
  CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault('r', relation.relowner))) acl
  WHERE relation.oid = 'public.queue_tasks'::regclass;

  DROP VIEW public.queue_tasks;
  DROP INDEX IF EXISTS public.idx_tasks_admin_device_time;
  ALTER TABLE public.tasks DROP COLUMN IF EXISTS device_id;
  ALTER TABLE public.tasks ADD COLUMN device_id text GENERATED ALWAYS AS (request_payload ->> 'device_id') STORED;
  CREATE INDEX idx_tasks_admin_device_time
    ON public.tasks USING btree (device_id, submitted_at DESC NULLS LAST, id DESC NULLS LAST, status, model);

  EXECUTE format(
    'CREATE VIEW public.queue_tasks AS SELECT %s FROM public.tasks t LEFT JOIN public.task_payloads p ON p.task_id = t.id WHERE t.kind = %L',
    columns_sql,
    'queue'
  );

  IF view_owner IS NOT NULL AND view_owner IS DISTINCT FROM current_user THEN
    EXECUTE format('ALTER VIEW public.queue_tasks OWNER TO %I', view_owner);
  END IF;

  FOREACH statement IN ARRAY COALESCE(grants, ARRAY[]::text[]) LOOP
    EXECUTE statement;
  END LOOP;
END $$;
--> statement-breakpoint
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
