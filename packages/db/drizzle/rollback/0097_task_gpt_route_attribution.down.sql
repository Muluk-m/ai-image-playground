-- 只在回滚到 0096 代码后执行；重建旧视图时保留其现有授权，不猜测角色名。
DO $$
DECLARE
  grants text[];
  statement text;
BEGIN
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
  CREATE VIEW public.queue_tasks AS SELECT "id", "provider", "model", "status", "request_payload", "result_payload", "error_message", "error_type", "upstream_status", "upstream_body", "upstream_task_ids", "upstream_submitted_at", "submitted_at", "started_at", "completed_at", "user_id", "client_request_id", "attempt_count", "upstream_invocation_count", "next_retry_at", "device_id", "agent_conversation_id", "agent_turn_id", "kind" FROM public.tasks WHERE "kind" = 'queue';
  FOREACH statement IN ARRAY COALESCE(grants, ARRAY[]::text[]) LOOP
    EXECUTE statement;
  END LOOP;
  ALTER TABLE public.tasks DROP COLUMN IF EXISTS gpt_key_fingerprint;
END $$;
