-- 记录 GPT Image 最终实际走的通道，以及最后一次直连请求的 key 指纹。
-- 只存 HMAC 指纹，不存密钥；旧任务保持 NULL。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "gpt_key_fingerprint" text;
--> statement-breakpoint
-- PostgreSQL 不能用 CREATE OR REPLACE VIEW 给视图追加列。
-- 视图没有依赖对象；重建后立即恢复运营只读账号的权限。
DROP VIEW IF EXISTS "queue_tasks";
--> statement-breakpoint
CREATE VIEW "queue_tasks" AS SELECT "id", "provider", "model", "status", "request_payload", "result_payload", "error_message", "error_type", "upstream_status", "upstream_body", "upstream_task_ids", "upstream_submitted_at", "gpt_route", "gpt_key_fingerprint", "submitted_at", "started_at", "completed_at", "user_id", "client_request_id", "attempt_count", "upstream_invocation_count", "next_retry_at", "device_id", "agent_conversation_id", "agent_turn_id", "kind" FROM "tasks" WHERE "tasks"."kind" = 'queue';
--> statement-breakpoint
DO $$
DECLARE "role" text;
BEGIN
  FOR "role" IN SELECT "rolname" FROM "pg_roles" WHERE "rolname" LIKE '%readonly%' OR "rolname" LIKE '%ops_ro%' LOOP
    EXECUTE format('GRANT SELECT ON TABLE "queue_tasks" TO %I', "role");
    EXECUTE format('REVOKE ALL ON TABLE "tasks" FROM %I', "role");
  END LOOP;
END $$;
