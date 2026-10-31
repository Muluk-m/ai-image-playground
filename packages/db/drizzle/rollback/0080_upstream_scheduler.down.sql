ALTER TABLE "tasks" DROP COLUMN IF EXISTS "gpt_route";
DROP TABLE IF EXISTS "gpt_direct_usage";
DROP TABLE IF EXISTS "scheduler_leases";
DROP TABLE IF EXISTS "scheduler_buckets";
