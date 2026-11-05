CREATE INDEX "idx_tasks_model_submitted" ON "tasks" ("model", "submitted_at" DESC, "id" DESC) WHERE "kind" = 'queue';
CREATE INDEX "idx_tasks_provider_submitted" ON "tasks" ("provider", "submitted_at" DESC, "id" DESC) WHERE "kind" = 'queue';
CREATE INDEX "idx_tasks_status_submitted" ON "tasks" ("status", "submitted_at" DESC, "id" DESC) WHERE "kind" = 'queue';
CREATE INDEX "idx_tasks_error_submitted" ON "tasks" ("error_type", "submitted_at" DESC, "id" DESC) WHERE "kind" = 'queue' AND "error_type" IS NOT NULL;
CREATE INDEX "idx_users_status_created" ON "users" ("status", "created_at" DESC, "id" DESC);
CREATE INDEX "idx_users_last_login" ON "users" ("last_login_at" DESC, "id" DESC) WHERE "last_login_at" IS NOT NULL;
CREATE INDEX "idx_operator_audits_operator_time" ON "operator_audits" ("operator_id", "created_at" DESC, "id" DESC);
