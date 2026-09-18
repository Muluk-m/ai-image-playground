DROP TRIGGER guard_legacy_task_claim ON tasks;
DROP FUNCTION guard_legacy_task_claim();
DROP TABLE deployment_controls;
ALTER TABLE agent_conversations DROP COLUMN runtime_generation;
DROP TABLE agent_executions;
DROP INDEX idx_tasks_lease_expires;
ALTER TABLE tasks DROP COLUMN lease_expires_at;
ALTER TABLE tasks DROP COLUMN execution_token;
