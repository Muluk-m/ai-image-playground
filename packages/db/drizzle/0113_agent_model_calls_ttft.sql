-- 为 Agent 模型调用表补充可空的首 Token 延迟（TTFT，毫秒），用于健康监测页面统计各模型首字响应表现。
-- 仅追加可空列（PostgreSQL 11+ 元数据级操作，零锁表，兼容滚发期旧版本代码）；历史记录保持 NULL。
-- 回滚见 drizzle/rollback/0113_agent_model_calls_ttft.down.sql。

ALTER TABLE "agent_model_calls" ADD COLUMN IF NOT EXISTS "ttft_ms" integer;
