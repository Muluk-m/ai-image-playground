CREATE TABLE "server_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "at" timestamp with time zone NOT NULL,
  "service" text NOT NULL,
  "instance" text NOT NULL,
  "version" text NOT NULL,
  "level" text NOT NULL,
  "event" text,
  "group_key" text NOT NULL,
  "message" text NOT NULL,
  "request_id" text,
  "task_id" text,
  "fields" jsonb NOT NULL,
  CONSTRAINT "server_logs_service_check" CHECK ("service" IN ('bff', 'worker')),
  CONSTRAINT "server_logs_level_check" CHECK ("level" IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal'))
);
--> statement-breakpoint
CREATE INDEX "idx_server_logs_at" ON "server_logs" ("at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "idx_server_logs_service_level" ON "server_logs" ("service", "level", "at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_server_logs_request" ON "server_logs" ("request_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX "idx_server_logs_task" ON "server_logs" ("task_id", "at" DESC);
