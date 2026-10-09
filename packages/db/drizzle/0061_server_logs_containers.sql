ALTER TABLE "server_logs" DROP CONSTRAINT "server_logs_service_check";
--> statement-breakpoint
ALTER TABLE "server_logs" ADD CONSTRAINT "server_logs_service_check" CHECK ("service" IN ('bff', 'worker', 'admin', 'router', 'cloudflared', 'host-collector', 'pg-backup', 'migrate', 'web', 'other'));
