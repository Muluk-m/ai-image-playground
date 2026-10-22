-- 确认门（关掉直接出图时拦下的生成，见 BFF `tool-gate.ts`）：用户每发一条消息都要在会话锁里找出这个会话
-- 还等着确认的那几张卡。部分索引只收这样的消息，平时几乎是空的，不必扫整段对话历史。
CREATE INDEX IF NOT EXISTS "idx_agent_messages_pending_gate" ON "agent_messages" ("conversation_id") WHERE "deleted_at" IS NULL AND "content" @> '[{"type":"toolResult","status":"awaiting_confirmation","gated":true}]'::jsonb;
