-- 去掉空闲时可用并发。worker 读不到这一列时回到只按 max_concurrent_tasks 放行。
ALTER TABLE "billing_plans" DROP CONSTRAINT IF EXISTS "billing_plans_idle_concurrent_tasks_check";
ALTER TABLE "billing_plans" DROP COLUMN IF EXISTS "idle_concurrent_tasks";
