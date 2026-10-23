-- 唤醒与续跑按「哪一轮取走的」往回追发起消息（`lib/agent/experience.ts`），每跳按会话与消费轮次查一次。
CREATE INDEX IF NOT EXISTS "idx_agent_inbox_consumed_turn" ON "agent_inbox" ("conversation_id", "consumed_turn_id") WHERE "status" = 'consumed';
