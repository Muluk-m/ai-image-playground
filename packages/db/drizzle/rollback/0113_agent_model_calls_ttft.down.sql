-- 回滚 0113_agent_model_calls_ttft.sql：移除 agent_model_calls.ttft_ms 列。

ALTER TABLE "agent_model_calls" DROP COLUMN IF EXISTS "ttft_ms";
