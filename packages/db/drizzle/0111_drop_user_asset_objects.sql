-- ADR 0034 Contract Wave 2 / Contract 2b：删除已退场的旧素材台账表 public.user_asset_objects。
-- 前提：生产已完成 backfill-asset-media.ts 零差异验收，且 Wave 1（#2034 / Contract 2a）
-- 已全量上线并排空，线上与回滚基线均不再读写 user_asset_objects。
-- 1. 删除前在 DO 块内对仍存在未迁移行（如 test 环境或自托管直跳升级）做一次幂等零搬运补齐
--    （已回填生产库仅做毫秒级无写入反连接）；
-- 2. 删除 public.user_asset_objects（及其主键索引与外键约束）。
-- 回滚见 drizzle/rollback/0111_drop_user_asset_objects.down.sql。

DO $$
BEGIN
  IF to_regclass('public.user_asset_objects') IS NOT NULL THEN
    INSERT INTO public.media_objects (
      id,
      user_id,
      sha256,
      bytes,
      content_type,
      status,
      attachment_managed,
      attachment_lease_until,
      reserved_bytes,
      staging_key,
      object_key,
      preview_key,
      preview_bytes,
      asset_image_id,
      storage_scope,
      width,
      height,
      expires_at,
      created_at,
      updated_at
    )
    SELECT
      gen_random_uuid()::text,
      u.user_id,
      'asset:' || u.image_id,
      u.bytes,
      u.content_type,
      'ready',
      false,
      NULL,
      0,
      'users/' || u.user_id || '/assets/' || u.image_id,
      'users/' || u.user_id || '/assets/' || u.image_id,
      NULL,
      0,
      u.image_id,
      'object',
      NULL,
      NULL,
      u.created_at,
      u.created_at,
      NOW()
    FROM public.user_asset_objects u
    WHERE u.bytes > 0
      AND NOT EXISTS (
        SELECT 1 FROM public.media_objects m
        WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
      )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.media_references (user_id, media_id, owner_kind, owner_id, created_at)
    SELECT DISTINCT ua.user_id, m.id, 'asset', ua.id, COALESCE(ua.created_at, ua.updated_at)
    FROM public.user_assets ua
    CROSS JOIN LATERAL (
      SELECT ua.image_id AS image_id
      WHERE ua.image_id IS NOT NULL AND ua.image_id <> ''
      UNION
      SELECT v->>'imageId' AS image_id
      FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
      WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
    ) img
    JOIN public.media_objects m
      ON m.user_id = ua.user_id
      AND m.asset_image_id = img.image_id
      AND m.status <> 'deleting'
    WHERE ua.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.media_references r
        WHERE r.user_id = ua.user_id
          AND r.media_id = m.id
          AND r.owner_kind = 'asset'
          AND r.owner_id = ua.id
      )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.media_references (user_id, media_id, owner_kind, owner_id, created_at)
    SELECT DISTINCT ul.user_id, m.id, 'look', ul.id, COALESCE(ul.created_at, ul.updated_at)
    FROM public.user_looks ul
    CROSS JOIN LATERAL (
      SELECT ul.cover_image_id AS image_id
      WHERE ul.cover_image_id IS NOT NULL AND ul.cover_image_id <> ''
      UNION
      SELECT r AS image_id
      FROM jsonb_array_elements_text(COALESCE(ul.reference_image_ids, '[]'::jsonb)) AS r
      WHERE r <> ''
    ) img
    JOIN public.media_objects m
      ON m.user_id = ul.user_id
      AND m.asset_image_id = img.image_id
      AND m.status <> 'deleting'
    WHERE ul.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.media_references r
        WHERE r.user_id = ul.user_id
          AND r.media_id = m.id
          AND r.owner_kind = 'look'
          AND r.owner_id = ul.id
      )
    ON CONFLICT DO NOTHING;

    INSERT INTO public.media_references (user_id, media_id, owner_kind, owner_id, created_at)
    SELECT crm.user_id, crm.media_id, 'cli_reference', crm.media_id, crm.created_at
    FROM public.cli_reference_media crm
    JOIN public.media_objects m
      ON m.id = crm.media_id
      AND m.user_id = crm.user_id
      AND m.status <> 'deleting'
    WHERE NOT EXISTS (
      SELECT 1 FROM public.media_references r
      WHERE r.user_id = crm.user_id
        AND r.media_id = crm.media_id
        AND r.owner_kind = 'cli_reference'
        AND r.owner_id = crm.media_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
--> statement-breakpoint
-- DROP TABLE 删除外键时会对父表 public.users 拿 ACCESS EXCLUSIVE 锁；等不到则快速失败由发布重试，避免排队阻塞线上流量。
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."user_asset_objects";
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
