-- 连点防重按「同账号 + 同请求内容 + 最近 2 秒」查回执：主键 (user_id, command_id) 用不上，补一个对应的索引。
CREATE INDEX IF NOT EXISTS "idx_generation_commands_recent" ON "generation_commands" ("user_id", "request_hash", "submitted_at");
