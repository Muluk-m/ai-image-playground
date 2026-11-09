-- 回滚到 0096 的公开任务视图；gpt_route 是旧版本已有字段，不删除。
DROP VIEW IF EXISTS "queue_tasks";
--> statement-breakpoint
CREATE VIEW "queue_tasks" AS SELECT "id", "provider", "model", "status", "request_payload", "result_payload", "error_message", "error_type", "upstream_status", "upstream_body", "upstream_task_ids", "upstream_submitted_at", "submitted_at", "started_at", "completed_at", "user_id", "client_request_id", "attempt_count", "upstream_invocation_count", "next_retry_at", "device_id", "agent_conversation_id", "agent_turn_id", "kind" FROM "tasks" WHERE "tasks"."kind" = 'queue';
--> statement-breakpoint
DO $$
DECLARE "role" text;
BEGIN
  FOR "role" IN SELECT "rolname" FROM "pg_roles" WHERE "rolname" LIKE '%readonly%' OR "rolname" LIKE '%ops_ro%' LOOP
    EXECUTE format('GRANT SELECT ON TABLE "queue_tasks" TO %I', "role");
    EXECUTE format('REVOKE ALL ON TABLE "tasks" FROM %I', "role");
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "gpt_key_fingerprint";
