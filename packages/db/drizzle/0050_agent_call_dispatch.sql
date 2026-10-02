ALTER TABLE "agent_model_calls" ADD COLUMN "http_dispatch_count" integer;
--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD COLUMN "request_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "agent_model_calls" ADD COLUMN "local_rejection" text;
