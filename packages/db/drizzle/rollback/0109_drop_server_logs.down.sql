CREATE TABLE IF NOT EXISTS "server_logs" (
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
  CONSTRAINT "server_logs_service_check" CHECK ("service" IN ('bff', 'worker', 'admin', 'router', 'cloudflared', 'host-collector', 'pg-backup', 'migrate', 'web', 'other')),
  CONSTRAINT "server_logs_level_check" CHECK ("level" IN ('trace', 'debug', 'info', 'warn', 'error', 'fatal'))
);
CREATE INDEX IF NOT EXISTS "idx_server_logs_at" ON "server_logs" ("at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "idx_server_logs_instance_at" ON "server_logs" USING btree ("instance","at" DESC,"id" DESC);
CREATE INDEX IF NOT EXISTS "idx_server_logs_service_level" ON "server_logs" ("service", "level", "at" DESC);
CREATE INDEX IF NOT EXISTS "idx_server_logs_request" ON "server_logs" ("request_id", "at" DESC);
CREATE INDEX IF NOT EXISTS "idx_server_logs_task" ON "server_logs" ("task_id", "at" DESC);
