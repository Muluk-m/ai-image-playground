-- 回滚 0108_media_objects_asset_image_index.sql：删除 media_objects(user_id, asset_image_id) 部分唯一索引。
DROP INDEX IF EXISTS "public"."idx_media_objects_owner_asset_image";
