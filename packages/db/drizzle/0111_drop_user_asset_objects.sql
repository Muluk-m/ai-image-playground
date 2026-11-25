-- ADR 0034 Contract Wave 2 / Contract 2b：删除已退场的旧素材台账表 public.user_asset_objects。
-- 前提：生产已完成 backfill-asset-media.ts 零差异验收，且 Wave 1（#2034 / Contract 2a）
-- 已全量上线并排空，线上与回滚基线均不再读写 user_asset_objects。
-- 1. 删除前在 DO 块内对仍存在未迁移行（如 test 环境或自托管直跳升级）做一次幂等零搬运补齐：
--    先通过反连接筛出确实缺行的 user_id（已回填生产库返回 0 行、零锁零写），
--    仅对命中的用户按与线上同步相同的全局锁序（users FOR NO KEY UPDATE -> user_sync_state FOR UPDATE）
--    串行持锁后在新快照中重读并补齐，杜绝并发同步墓碑复活幽灵引用或并发删号触发 23503；
-- 2. 删除 public.user_asset_objects（及其主键索引与外键约束），统一在 lock_timeout = '5s' 保护下执行。
-- 回滚见 drizzle/rollback/0111_drop_user_asset_objects.down.sql。

-- 补齐持行锁与 DROP TABLE 删除外键（对父表 public.users 拿 ACCESS EXCLUSIVE 锁）均受 5s 超时保护：
-- 等不到则快速失败由发布重试，避免排队阻塞线上流量。
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
DECLARE
  v_user_id text;
BEGIN
  IF to_regclass('public.user_asset_objects') IS NOT NULL THEN
    FOR v_user_id IN
      SELECT DISTINCT user_id FROM (
        SELECT u.user_id
        FROM public.user_asset_objects u
        WHERE u.bytes > 0
          AND NOT EXISTS (
            SELECT 1 FROM public.media_objects m
            WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
          )
        UNION
        SELECT ua.user_id
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
        UNION
        SELECT ul.user_id
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
        UNION
        SELECT crm.user_id
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
      ) pending
      ORDER BY user_id
    LOOP
      PERFORM 1 FROM public.users WHERE id = v_user_id FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      INSERT INTO public.user_sync_state (user_id, version)
      VALUES (v_user_id, 0)
      ON CONFLICT (user_id) DO NOTHING;

      PERFORM 1 FROM public.user_sync_state WHERE user_id = v_user_id FOR UPDATE;

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
      WHERE u.user_id = v_user_id
        AND u.bytes > 0
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
      WHERE ua.user_id = v_user_id
        AND ua.deleted_at IS NULL
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
      WHERE ul.user_id = v_user_id
        AND ul.deleted_at IS NULL
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
      WHERE crm.user_id = v_user_id
        AND NOT EXISTS (
          SELECT 1 FROM public.media_references r
          WHERE r.user_id = crm.user_id
            AND r.media_id = crm.media_id
            AND r.owner_kind = 'cli_reference'
            AND r.owner_id = crm.media_id
        )
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."user_asset_objects";
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
