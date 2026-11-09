-- 记录 GPT Image 最终实际走的通道，以及最后一次直连请求的 key 指纹。
-- 只存 HMAC 指纹，不存密钥；旧任务保持 NULL。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "gpt_key_fingerprint" text;
--> statement-breakpoint
-- 在现有列末尾追加归因字段，保留视图对象、依赖和既有授权。
CREATE OR REPLACE VIEW "queue_tasks" AS SELECT "id", "provider", "model", "status", "request_payload", "result_payload", "error_message", "error_type", "upstream_status", "upstream_body", "upstream_task_ids", "upstream_submitted_at", "submitted_at", "started_at", "completed_at", "user_id", "client_request_id", "attempt_count", "upstream_invocation_count", "next_retry_at", "device_id", "agent_conversation_id", "agent_turn_id", "kind", "gpt_route", "gpt_key_fingerprint" FROM "tasks" WHERE "tasks"."kind" = 'queue';
