DELETE FROM "server_logs" WHERE "service" NOT IN ('bff', 'worker');
ALTER TABLE "server_logs" DROP CONSTRAINT "server_logs_service_check";
ALTER TABLE "server_logs" ADD CONSTRAINT "server_logs_service_check" CHECK ("service" IN ('bff', 'worker'));
