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
--> statement-breakpoint
-- OpenAI 直连每次请求的成本（按上游回报的 token 折算，拿不到用量时按档位估算），用来按月预算封顶。
CREATE TABLE IF NOT EXISTS "gpt_direct_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text,
	"model" text NOT NULL,
	"size" text,
	"quality" text,
	"images" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micro_usd" bigint NOT NULL,
	"estimated" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gpt_direct_usage_created" ON "gpt_direct_usage" USING btree ("created_at");
--> statement-breakpoint
-- GPT Image 这一单最后走的通道（direct / sub2api）。会员的高档参数落到 sub2api 只出基础档，结算据此按实际档位。
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "gpt_route" text;
