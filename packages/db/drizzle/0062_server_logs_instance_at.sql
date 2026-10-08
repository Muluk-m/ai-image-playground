CREATE INDEX "idx_server_logs_instance_at" ON "server_logs" USING btree ("instance","at" DESC,"id" DESC);
