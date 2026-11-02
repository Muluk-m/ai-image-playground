-- 模型上下架从收费模块挪到公开库：内部版也能停用模型，账号池不足时自动暂停。没有行即上架。
CREATE TABLE IF NOT EXISTS "model_availability" (
	"model" text PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"pause_reason" text,
	"paused_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
