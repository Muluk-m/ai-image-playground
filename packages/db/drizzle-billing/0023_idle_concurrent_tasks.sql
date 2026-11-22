-- 空闲时可用并发（弹性名额）：服务器有余量且没有别人排队时，订阅账号最多同时跑多少个任务。
-- NULL = 不享受，只按 max_concurrent_tasks。它不是对外承诺的权益，不进 billing_plan_immutable_rights；
-- 只有公开仓 WORKER_IDLE_CONCURRENCY_ENABLED=true 时 worker 才会看这一列。
ALTER TABLE "billing_plans" ADD COLUMN "idle_concurrent_tasks" integer;--> statement-breakpoint
ALTER TABLE "billing_plans" ADD CONSTRAINT "billing_plans_idle_concurrent_tasks_check"
  CHECK ("idle_concurrent_tasks" IS NULL OR "idle_concurrent_tasks" >= "max_concurrent_tasks");--> statement-breakpoint
-- 只给入门版（含后台改价生成的 starter-xxxxxxxx 版本）开 2；标准版、专业版保持 NULL。
UPDATE "billing_plans" SET "idle_concurrent_tasks" = 2
  WHERE ("id" = 'starter' OR "id" LIKE 'starter-%') AND "max_concurrent_tasks" < 2;
