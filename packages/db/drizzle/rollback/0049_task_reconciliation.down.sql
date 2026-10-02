-- New producers must be disabled and every opted-in task settled before reverting consumers.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE reconciliation_required AND status IN ('queued', 'in_progress', 'reconciling')) THEN
    RAISE EXCEPTION 'Unsettled reconciliation tasks require compatible consumers';
  END IF;
END $$;
DROP TABLE task_dispatches;
ALTER TABLE tasks DROP CONSTRAINT tasks_reconciling_check;
ALTER TABLE tasks DROP COLUMN reconciliation_required;
