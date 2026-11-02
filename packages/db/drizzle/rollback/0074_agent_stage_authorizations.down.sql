DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "agent_stage_authorizations") THEN
    RAISE EXCEPTION 'cannot discard stage authorization history';
  END IF;
END $$;
DROP TABLE "agent_stage_authorizations";
