-- Phase 5 / PR-5.4a（媒体账本统一 Expand，纯元数据快操作）：
-- 1. 为 media_objects 增加 asset_image_id（映射旧 user_asset_objects.image_id）与 storage_scope
--    （区分 durableMediaStore 与 objectStore 前缀，零 R2 文件搬运）；
-- 2. 扩展 media_references.owner_kind 覆盖 'cli_reference' 与 'look'，统一全部媒体归属与引用计数；
-- 3. 将 media_references.media_id 外键从 RESTRICT 改为 NO ACTION，保留直接删 media_objects 的 23503 保护，
--    同时消除 DELETE users 级联删除时的触发器顺序误报 23503。
-- 所有约束均以 NOT VALID 立即释放 ACCESS EXCLUSIVE 锁；全表校验（VALIDATE CONSTRAINT，仅 SHARE UPDATE EXCLUSIVE）
-- 放在独立事务 0108_media_objects_asset_image_index.sql 中执行，避免阻塞线上读写。
-- 回滚见 drizzle/rollback/0107_media_ledger_unification.down.sql。
ALTER TABLE public.media_objects ADD COLUMN IF NOT EXISTS asset_image_id text;
--> statement-breakpoint
ALTER TABLE public.media_objects ADD COLUMN IF NOT EXISTS storage_scope text NOT NULL DEFAULT 'durable';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.media_objects'::regclass
      AND conname = 'media_objects_storage_scope_check'
  ) THEN
    ALTER TABLE public.media_objects
      ADD CONSTRAINT media_objects_storage_scope_check
      CHECK (storage_scope IN ('durable', 'object')) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE public.media_references DROP CONSTRAINT IF EXISTS media_references_owner_kind_check;
--> statement-breakpoint
ALTER TABLE public.media_references
  ADD CONSTRAINT media_references_owner_kind_check
  CHECK (owner_kind IN ('project', 'asset', 'conversation', 'generation', 'batch', 'analysis', 'cli_reference', 'look')) NOT VALID;
--> statement-breakpoint
ALTER TABLE public.media_references DROP CONSTRAINT IF EXISTS media_references_media_id_fkey;
--> statement-breakpoint
ALTER TABLE public.media_references
  ADD CONSTRAINT media_references_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES public.media_objects(id) ON DELETE NO ACTION NOT VALID;
