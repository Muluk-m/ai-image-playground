-- Soft delete for generation history: a user removing a work only hides the record, so the media
-- objects it points at stay readable for the canvas and for any other record sharing them.
ALTER TABLE "generation_records" ADD COLUMN "deleted_at" timestamp with time zone;
