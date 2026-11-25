-- 回滚 0107_media_ledger_unification.sql：
-- 1. 将仅存在于 media_objects 中的已上传素材对象回同步到 user_asset_objects，避免回滚丢资产；
-- 2. 清理新增的 'cli_reference'/'look' 引用及指向旧对象范围的 media_references，并恢复 owner_kind 约束；
-- 3. 删除迁移/双写写入的 asset_image_id 媒体行与新增列。
INSERT INTO public.user_asset_objects (user_id, image_id, bytes, content_type, created_at)
SELECT user_id, asset_image_id, bytes::integer, content_type, created_at
FROM public.media_objects
WHERE asset_image_id IS NOT NULL
  AND status <> 'deleting'
  AND bytes <= 2147483647
ON CONFLICT (user_id, image_id) DO NOTHING;
--> statement-breakpoint
DELETE FROM public.media_references
WHERE owner_kind IN ('cli_reference', 'look')
   OR media_id IN (SELECT id FROM public.media_objects WHERE asset_image_id IS NOT NULL);
--> statement-breakpoint
DELETE FROM public.media_objects WHERE asset_image_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.media_references DROP CONSTRAINT IF EXISTS media_references_media_id_fkey;
--> statement-breakpoint
ALTER TABLE public.media_references
  ADD CONSTRAINT media_references_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES public.media_objects(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE public.media_references DROP CONSTRAINT IF EXISTS media_references_owner_kind_check;
--> statement-breakpoint
ALTER TABLE public.media_references
  ADD CONSTRAINT media_references_owner_kind_check
  CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation', 'batch', 'analysis'));
--> statement-breakpoint
ALTER TABLE public.media_objects DROP CONSTRAINT IF EXISTS media_objects_storage_scope_check;
--> statement-breakpoint
ALTER TABLE public.media_objects DROP COLUMN IF EXISTS storage_scope;
--> statement-breakpoint
ALTER TABLE public.media_objects DROP COLUMN IF EXISTS asset_image_id;
