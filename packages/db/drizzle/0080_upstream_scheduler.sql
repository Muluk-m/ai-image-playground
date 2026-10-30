-- 上游调度配额：同一环境的所有 worker 在这两张表上按行锁抢额度（GPT 直连每模型每分钟张数、同时在途请求数）。
-- 桶的上限来自各环境的配置，不存表；表里只有状态。
CREATE TABLE IF NOT EXISTS "scheduler_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"cooldown_until" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduler_leases" (
	"attempt_id" text NOT NULL,
	"bucket_key" text NOT NULL,
	"images" integer NOT NULL,
	"worker_id" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "scheduler_leases_attempt_id_bucket_key_pk" PRIMARY KEY("attempt_id","bucket_key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_scheduler_leases_bucket_acquired" ON "scheduler_leases" USING btree ("bucket_key","acquired_at");
