-- 提交请求的 W3C traceparent，worker 执行时用 span link 接回提交链路（ADR 0033）。
-- 只加可空列：旧代码不读不写，旧任务保持 NULL；不进 queue_tasks 视图。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "traceparent" text;
