-- Phase 5 / PR-5.4a：在 0107 提交后的独立事务中验证新约束（仅持 SHARE UPDATE EXCLUSIVE 锁，不阻塞线上读写），
-- 并确保 media_objects(user_id, asset_image_id) 部分唯一索引已就绪。
-- 既有线上库由 packages/db/src/migrate.ts 在事务外先用 CREATE UNIQUE INDEX CONCURRENTLY 建好；
-- 这里检查 pg_index.indisvalid 后跳过，避免对热表 media_objects 加 SHARE 锁，同时保持空库迁移自洽。
-- 回滚见 drizzle/rollback/0108_media_objects_asset_image_index.down.sql。
ALTER TABLE public.media_objects VALIDATE CONSTRAINT media_objects_storage_scope_check;
--> statement-breakpoint
ALTER TABLE public.media_references VALIDATE CONSTRAINT media_references_owner_kind_check;
--> statement-breakpoint
ALTER TABLE public.media_references VALIDATE CONSTRAINT media_references_media_id_fkey;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname = 'idx_media_objects_owner_asset_image'
      AND i.indisvalid
  ) THEN
    CREATE UNIQUE INDEX "idx_media_objects_owner_asset_image"
      ON "public"."media_objects" USING btree ("user_id", "asset_image_id")
      WHERE "asset_image_id" IS NOT NULL;
  END IF;
END $$;
