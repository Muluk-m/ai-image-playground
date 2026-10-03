ALTER TABLE "media_objects" ADD COLUMN "attachment_managed" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "media_objects" ADD COLUMN "attachment_lease_until" timestamptz;
--> statement-breakpoint
ALTER TABLE "media_objects" DROP CONSTRAINT "media_objects_status_check";
--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_status_check" CHECK (status IN ('pending', 'ready', 'deleting'));
