ALTER TABLE "host_samples" ADD COLUMN "cpu_count" integer;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "cpu_busy_ratio" double precision;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "load_1" double precision;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "load_5" double precision;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "load_15" double precision;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "swap_total_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "swap_free_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "host_samples" ADD COLUMN "booted_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "container_samples" (
	"sampled_at" timestamp with time zone NOT NULL,
	"container_id" text NOT NULL,
	"name" text,
	"mem_bytes" bigint NOT NULL,
	"mem_limit_bytes" bigint,
	"cpu_cores" double precision,
	"oom_kills" integer NOT NULL,
	CONSTRAINT "container_samples_sampled_at_container_id_pk" PRIMARY KEY("sampled_at","container_id")
);
--> statement-breakpoint
CREATE TABLE "api_minutes" (
	"minute" timestamp with time zone NOT NULL,
	"instance" text NOT NULL,
	"requests" integer NOT NULL,
	"client_errors" integer NOT NULL,
	"server_errors" integer NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	"max_ms" integer,
	"server_error_routes" jsonb,
	CONSTRAINT "api_minutes_minute_instance_pk" PRIMARY KEY("minute","instance")
);
