-- Retire every analysis execution and its durable records before downgrading consumers.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tasks WHERE kind = 'analysis') OR EXISTS (SELECT 1 FROM analysis_tasks) OR EXISTS (SELECT 1 FROM media_references WHERE owner_kind = 'analysis') THEN
    RAISE EXCEPTION 'Finish analysis lifecycle work before downgrading';
  END IF;
END $$;
DROP TABLE analysis_model_calls;
DROP TABLE analysis_tasks;
ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (kind IN ('queue', 'chat'));
ALTER TABLE media_references DROP CONSTRAINT media_references_owner_kind_check;
ALTER TABLE media_references ADD CONSTRAINT media_references_owner_kind_check CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation', 'batch'));
