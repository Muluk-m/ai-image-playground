-- An asset stops being "a name for one image" and becomes an ordered group of views of one subject.
-- `views` holds `[{ "imageId": ..., "label": ..., "source": ... }]` with the cover first; `image_id`
-- keeps mirroring `views[0].imageId` so a client that predates views still reads the cover. Rows
-- written before this migration stay NULL and every read path expands them into a single view
-- labelled "none" from `upload`, so no backfill is needed and a rollback loses nothing but the group.
ALTER TABLE "user_assets" ADD COLUMN "kind" text;
--> statement-breakpoint
ALTER TABLE "user_assets" ADD COLUMN "background" text;
--> statement-breakpoint
ALTER TABLE "user_assets" ADD COLUMN "views" jsonb;
