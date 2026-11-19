-- 只在回滚到 0098 代码后执行。
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "traceparent";
