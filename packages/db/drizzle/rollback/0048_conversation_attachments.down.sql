-- Downgrade only after disabling uploads and completing the lifecycle of all managed attachments.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM media_objects WHERE status = 'deleting' OR attachment_managed) THEN
    RAISE EXCEPTION 'Finish attachment lifecycle work before downgrading';
  END IF;
END $$;
ALTER TABLE "media_objects" DROP CONSTRAINT "media_objects_status_check";
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_status_check" CHECK (status IN ('pending', 'ready'));
ALTER TABLE "media_objects" DROP COLUMN "attachment_lease_until";
ALTER TABLE "media_objects" DROP COLUMN "attachment_managed";
