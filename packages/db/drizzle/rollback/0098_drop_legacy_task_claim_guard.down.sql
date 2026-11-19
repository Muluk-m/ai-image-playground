-- 只在回滚到 0097 代码后执行：按 0029 原样重建闸门，开关保持关闭。
CREATE TABLE IF NOT EXISTS deployment_controls (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false);
INSERT INTO deployment_controls (key, enabled) VALUES ('legacy_claims_disabled', false) ON CONFLICT (key) DO NOTHING;
CREATE OR REPLACE FUNCTION guard_legacy_task_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE gate_enabled boolean;
BEGIN
  SELECT enabled INTO gate_enabled FROM deployment_controls WHERE key = 'legacy_claims_disabled' FOR SHARE;
  IF OLD.status = 'queued' AND NEW.status = 'in_progress' AND NEW.execution_token IS NULL
     AND gate_enabled THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS guard_legacy_task_claim ON tasks;
CREATE TRIGGER guard_legacy_task_claim BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION guard_legacy_task_claim();
