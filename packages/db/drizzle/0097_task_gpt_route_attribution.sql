-- 记录 GPT Image 最终实际走的通道，以及最后一次直连请求的 key 指纹。
-- 只存 HMAC 指纹，不存密钥；旧任务保持 NULL。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "gpt_key_fingerprint" text;
--> statement-breakpoint
-- 历史 0015 用 SELECT * 建视图，后续加表列不会更新视图；保留实际顺序再追加缺列。
-- 不 DROP 视图，不改既有授权或依赖，不暴露执行器私有列。
DO $$
DECLARE
  columns_sql text;
BEGIN
  SELECT string_agg(format('%I', name), ', ' ORDER BY position) INTO columns_sql
  FROM (
    SELECT attname AS name, attnum::bigint AS position
    FROM pg_attribute
    WHERE attrelid = 'public.queue_tasks'::regclass AND attnum > 0 AND NOT attisdropped
    UNION ALL
    SELECT name, 1000 + position
    FROM unnest(ARRAY[
      'id', 'provider', 'model', 'status', 'request_payload', 'result_payload',
      'error_message', 'error_type', 'upstream_status', 'upstream_body',
      'upstream_task_ids', 'upstream_submitted_at', 'submitted_at', 'started_at',
      'completed_at', 'user_id', 'client_request_id', 'attempt_count',
      'upstream_invocation_count', 'next_retry_at', 'device_id',
      'agent_conversation_id', 'agent_turn_id', 'kind', 'gpt_route', 'gpt_key_fingerprint'
    ]) WITH ORDINALITY AS expected(name, position)
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'public.queue_tasks'::regclass AND attnum > 0 AND NOT attisdropped
        AND attname = expected.name
    )
  ) AS selected;
  EXECUTE format('CREATE OR REPLACE VIEW public.queue_tasks AS SELECT %s FROM public.tasks WHERE kind = %L', columns_sql, 'queue');
END $$;
