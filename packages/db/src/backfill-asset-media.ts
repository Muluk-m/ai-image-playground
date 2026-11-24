import type { SQL } from 'bun'

export type BackfillAssetMediaPhase =
  | 'objects'
  | 'asset_refs'
  | 'look_refs'
  | 'cli_refs'
  | 'prune_stale_refs'

export interface BackfillAssetMediaOptions {
  /** Number of unmigrated source rows scanned per keyset batch (default 1000, max 10000). */
  readonly batchSize?: number
  /** Pause between batches in milliseconds to throttle WAL and I/O (default 50). */
  readonly delayMs?: number
  /** Stop after this many total batches across all phases if set (useful for bounded maintenance slices). */
  readonly maxBatches?: number
  readonly onBatch?: (progress: BackfillAssetMediaBatch) => void
}

export interface BackfillAssetMediaBatch {
  readonly phase: BackfillAssetMediaPhase
  readonly batchNumber: number
  readonly scanned: number
  readonly written: number
}

export interface BackfillAssetMediaResult {
  readonly batches: number
  readonly objectsScanned: number
  readonly objectsWritten: number
  readonly assetRefsScanned: number
  readonly assetRefsWritten: number
  readonly lookRefsScanned: number
  readonly lookRefsWritten: number
  readonly cliRefsScanned: number
  readonly cliRefsWritten: number
  readonly staleRefsPruned: number
  readonly completed: boolean
}

export interface AssetMediaConsistencyReport {
  readonly totalLegacyAssets: number
  readonly totalUnifiedAssetMedia: number
  readonly missingAssetMediaCount: number
  readonly missingAssetRefCount: number
  readonly missingLookRefCount: number
  readonly missingCliRefCount: number
  readonly staleSyncedRefCount: number
  readonly sampleMissingAssetImages: readonly string[]
}

interface PairBatchRow {
  readonly scanned: number
  readonly written: number
  readonly last_user_id: string | null
  readonly last_item_id: string | null
}

interface SingleBatchRow {
  readonly scanned: number
  readonly written: number
  readonly last_id: string | null
}

const MAX_FK_RACE_RETRIES = 3

function isForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { errno?: unknown; code?: unknown }
  return record.errno === '23503' || record.code === '23503'
}

async function withFkRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt < MAX_FK_RACE_RETRIES && isForeignKeyViolation(error)) {
        continue
      }
      throw error
    }
  }
}

async function runAssetObjectsBatch(
  client: SQL,
  cursor: { userId: string; itemId: string } | null,
  batchSize: number,
): Promise<PairBatchRow> {
  // Filter missing rows INSIDE `batch` so bounded `--max-batches` slices make forward progress on
  // every re-run without needing external cursors. Keep `reserved_bytes = 0` during Phase 5.4a
  // Expand so pre-5.4a BFF containers (which sum `media_objects.reserved_bytes + user_asset_objects.bytes`)
  // do not double-count assets during rolling deploys or BFF-only rollbacks.
  return withFkRetry(async () => {
    const [row] =
      cursor === null
        ? await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT u.user_id, u.image_id, u.bytes, u.content_type, u.created_at
              FROM user_asset_objects u
              WHERE u.bytes > 0
                AND NOT EXISTS (
                  SELECT 1 FROM media_objects m
                  WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
                )
              ORDER BY u.user_id ASC, u.image_id ASC
              LIMIT ${batchSize}
            ),
            inserted AS (
              INSERT INTO media_objects (
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
                b.user_id,
                'asset:' || b.image_id,
                b.bytes,
                b.content_type,
                'ready',
                false,
                NULL,
                0,
                'users/' || b.user_id || '/assets/' || b.image_id,
                'users/' || b.user_id || '/assets/' || b.image_id,
                NULL,
                0,
                b.image_id,
                'object',
                NULL,
                NULL,
                b.created_at,
                b.created_at,
                b.created_at
              FROM batch b
              ON CONFLICT DO NOTHING
              RETURNING id
            ),
            tail AS (
              SELECT user_id, image_id
              FROM batch
              ORDER BY user_id DESC, image_id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT image_id FROM tail) AS last_item_id
          `
        : await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT u.user_id, u.image_id, u.bytes, u.content_type, u.created_at
              FROM user_asset_objects u
              WHERE u.bytes > 0
                AND (u.user_id, u.image_id) > (${cursor.userId}, ${cursor.itemId})
                AND NOT EXISTS (
                  SELECT 1 FROM media_objects m
                  WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
                )
              ORDER BY u.user_id ASC, u.image_id ASC
              LIMIT ${batchSize}
            ),
            inserted AS (
              INSERT INTO media_objects (
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
                b.user_id,
                'asset:' || b.image_id,
                b.bytes,
                b.content_type,
                'ready',
                false,
                NULL,
                0,
                'users/' || b.user_id || '/assets/' || b.image_id,
                'users/' || b.user_id || '/assets/' || b.image_id,
                NULL,
                0,
                b.image_id,
                'object',
                NULL,
                NULL,
                b.created_at,
                b.created_at,
                b.created_at
              FROM batch b
              ON CONFLICT DO NOTHING
              RETURNING id
            ),
            tail AS (
              SELECT user_id, image_id
              FROM batch
              ORDER BY user_id DESC, image_id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT image_id FROM tail) AS last_item_id
          `
    return row ?? { scanned: 0, written: 0, last_user_id: null, last_item_id: null }
  })
}

async function runAssetRefsBatch(
  client: SQL,
  cursor: { userId: string; itemId: string } | null,
  batchSize: number,
): Promise<PairBatchRow> {
  return withFkRetry(async () => {
    const [row] =
      cursor === null
        ? await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT ua.user_id, ua.id, ua.image_id, ua.views, COALESCE(ua.created_at, ua.updated_at) AS ref_created_at
              FROM user_assets ua
              WHERE ua.deleted_at IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM (
                    SELECT ua.image_id AS image_id
                    WHERE ua.image_id IS NOT NULL AND ua.image_id <> ''
                    UNION
                    SELECT v->>'imageId' AS image_id
                    FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                    WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
                  ) img
                  JOIN media_objects m
                    ON m.user_id = ua.user_id
                    AND m.asset_image_id = img.image_id
                    AND m.status <> 'deleting'
                  WHERE NOT EXISTS (
                    SELECT 1 FROM media_references r
                    WHERE r.user_id = ua.user_id
                      AND r.owner_kind = 'asset'
                      AND r.owner_id = ua.id
                      AND r.media_id = m.id
                  )
                )
              ORDER BY ua.user_id ASC, ua.id ASC
              LIMIT ${batchSize}
            ),
            wanted AS (
              SELECT DISTINCT b.user_id, b.id AS owner_id, b.ref_created_at, img.image_id
              FROM batch b
              CROSS JOIN LATERAL (
                SELECT b.image_id AS image_id
                WHERE b.image_id IS NOT NULL AND b.image_id <> ''
                UNION
                SELECT v->>'imageId' AS image_id
                FROM jsonb_array_elements(COALESCE(b.views, '[]'::jsonb)) AS v
                WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
              ) img
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT w.user_id, m.id, 'asset', w.owner_id, w.ref_created_at
              FROM wanted w
              JOIN media_objects m
                ON m.user_id = w.user_id
                AND m.asset_image_id = w.image_id
                AND m.status <> 'deleting'
              ON CONFLICT DO NOTHING
              RETURNING media_id
            ),
            tail AS (
              SELECT user_id, id
              FROM batch
              ORDER BY user_id DESC, id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT id FROM tail) AS last_item_id
          `
        : await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT ua.user_id, ua.id, ua.image_id, ua.views, COALESCE(ua.created_at, ua.updated_at) AS ref_created_at
              FROM user_assets ua
              WHERE ua.deleted_at IS NULL
                AND (ua.user_id, ua.id) > (${cursor.userId}, ${cursor.itemId})
                AND EXISTS (
                  SELECT 1
                  FROM (
                    SELECT ua.image_id AS image_id
                    WHERE ua.image_id IS NOT NULL AND ua.image_id <> ''
                    UNION
                    SELECT v->>'imageId' AS image_id
                    FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                    WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
                  ) img
                  JOIN media_objects m
                    ON m.user_id = ua.user_id
                    AND m.asset_image_id = img.image_id
                    AND m.status <> 'deleting'
                  WHERE NOT EXISTS (
                    SELECT 1 FROM media_references r
                    WHERE r.user_id = ua.user_id
                      AND r.owner_kind = 'asset'
                      AND r.owner_id = ua.id
                      AND r.media_id = m.id
                  )
                )
              ORDER BY ua.user_id ASC, ua.id ASC
              LIMIT ${batchSize}
            ),
            wanted AS (
              SELECT DISTINCT b.user_id, b.id AS owner_id, b.ref_created_at, img.image_id
              FROM batch b
              CROSS JOIN LATERAL (
                SELECT b.image_id AS image_id
                WHERE b.image_id IS NOT NULL AND b.image_id <> ''
                UNION
                SELECT v->>'imageId' AS image_id
                FROM jsonb_array_elements(COALESCE(b.views, '[]'::jsonb)) AS v
                WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
              ) img
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT w.user_id, m.id, 'asset', w.owner_id, w.ref_created_at
              FROM wanted w
              JOIN media_objects m
                ON m.user_id = w.user_id
                AND m.asset_image_id = w.image_id
                AND m.status <> 'deleting'
              ON CONFLICT DO NOTHING
              RETURNING media_id
            ),
            tail AS (
              SELECT user_id, id
              FROM batch
              ORDER BY user_id DESC, id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT id FROM tail) AS last_item_id
          `
    return row ?? { scanned: 0, written: 0, last_user_id: null, last_item_id: null }
  })
}

async function runLookRefsBatch(
  client: SQL,
  cursor: { userId: string; itemId: string } | null,
  batchSize: number,
): Promise<PairBatchRow> {
  return withFkRetry(async () => {
    const [row] =
      cursor === null
        ? await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT ul.user_id, ul.id, ul.cover_image_id, ul.reference_image_ids, COALESCE(ul.created_at, ul.updated_at) AS ref_created_at
              FROM user_looks ul
              WHERE ul.deleted_at IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM (
                    SELECT ul.cover_image_id AS image_id
                    WHERE ul.cover_image_id IS NOT NULL AND ul.cover_image_id <> ''
                    UNION
                    SELECT r AS image_id
                    FROM jsonb_array_elements_text(COALESCE(ul.reference_image_ids, '[]'::jsonb)) AS r
                    WHERE r <> ''
                  ) img
                  JOIN media_objects m
                    ON m.user_id = ul.user_id
                    AND m.asset_image_id = img.image_id
                    AND m.status <> 'deleting'
                  WHERE NOT EXISTS (
                    SELECT 1 FROM media_references r
                    WHERE r.user_id = ul.user_id
                      AND r.owner_kind = 'look'
                      AND r.owner_id = ul.id
                      AND r.media_id = m.id
                  )
                )
              ORDER BY ul.user_id ASC, ul.id ASC
              LIMIT ${batchSize}
            ),
            wanted AS (
              SELECT DISTINCT b.user_id, b.id AS owner_id, b.ref_created_at, img.image_id
              FROM batch b
              CROSS JOIN LATERAL (
                SELECT b.cover_image_id AS image_id
                WHERE b.cover_image_id IS NOT NULL AND b.cover_image_id <> ''
                UNION
                SELECT r AS image_id
                FROM jsonb_array_elements_text(COALESCE(b.reference_image_ids, '[]'::jsonb)) AS r
                WHERE r <> ''
              ) img
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT w.user_id, m.id, 'look', w.owner_id, w.ref_created_at
              FROM wanted w
              JOIN media_objects m
                ON m.user_id = w.user_id
                AND m.asset_image_id = w.image_id
                AND m.status <> 'deleting'
              ON CONFLICT DO NOTHING
              RETURNING media_id
            ),
            tail AS (
              SELECT user_id, id
              FROM batch
              ORDER BY user_id DESC, id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT id FROM tail) AS last_item_id
          `
        : await client<PairBatchRow[]>`
            WITH batch AS (
              SELECT ul.user_id, ul.id, ul.cover_image_id, ul.reference_image_ids, COALESCE(ul.created_at, ul.updated_at) AS ref_created_at
              FROM user_looks ul
              WHERE ul.deleted_at IS NULL
                AND (ul.user_id, ul.id) > (${cursor.userId}, ${cursor.itemId})
                AND EXISTS (
                  SELECT 1
                  FROM (
                    SELECT ul.cover_image_id AS image_id
                    WHERE ul.cover_image_id IS NOT NULL AND ul.cover_image_id <> ''
                    UNION
                    SELECT r AS image_id
                    FROM jsonb_array_elements_text(COALESCE(ul.reference_image_ids, '[]'::jsonb)) AS r
                    WHERE r <> ''
                  ) img
                  JOIN media_objects m
                    ON m.user_id = ul.user_id
                    AND m.asset_image_id = img.image_id
                    AND m.status <> 'deleting'
                  WHERE NOT EXISTS (
                    SELECT 1 FROM media_references r
                    WHERE r.user_id = ul.user_id
                      AND r.owner_kind = 'look'
                      AND r.owner_id = ul.id
                      AND r.media_id = m.id
                  )
                )
              ORDER BY ul.user_id ASC, ul.id ASC
              LIMIT ${batchSize}
            ),
            wanted AS (
              SELECT DISTINCT b.user_id, b.id AS owner_id, b.ref_created_at, img.image_id
              FROM batch b
              CROSS JOIN LATERAL (
                SELECT b.cover_image_id AS image_id
                WHERE b.cover_image_id IS NOT NULL AND b.cover_image_id <> ''
                UNION
                SELECT r AS image_id
                FROM jsonb_array_elements_text(COALESCE(b.reference_image_ids, '[]'::jsonb)) AS r
                WHERE r <> ''
              ) img
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT w.user_id, m.id, 'look', w.owner_id, w.ref_created_at
              FROM wanted w
              JOIN media_objects m
                ON m.user_id = w.user_id
                AND m.asset_image_id = w.image_id
                AND m.status <> 'deleting'
              ON CONFLICT DO NOTHING
              RETURNING media_id
            ),
            tail AS (
              SELECT user_id, id
              FROM batch
              ORDER BY user_id DESC, id DESC
              LIMIT 1
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT user_id FROM tail) AS last_user_id,
              (SELECT id FROM tail) AS last_item_id
          `
    return row ?? { scanned: 0, written: 0, last_user_id: null, last_item_id: null }
  })
}

async function runCliRefsBatch(
  client: SQL,
  lastId: string | null,
  batchSize: number,
): Promise<SingleBatchRow> {
  return withFkRetry(async () => {
    const [row] =
      lastId === null
        ? await client<SingleBatchRow[]>`
            WITH batch AS (
              SELECT crm.media_id, crm.user_id, crm.created_at
              FROM cli_reference_media crm
              JOIN media_objects m ON m.id = crm.media_id AND m.user_id = crm.user_id
              WHERE NOT EXISTS (
                SELECT 1 FROM media_references r
                WHERE r.user_id = crm.user_id
                  AND r.owner_kind = 'cli_reference'
                  AND r.owner_id = crm.media_id
                  AND r.media_id = crm.media_id
              )
              ORDER BY crm.media_id ASC
              LIMIT ${batchSize}
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT b.user_id, b.media_id, 'cli_reference', b.media_id, b.created_at
              FROM batch b
              ON CONFLICT DO NOTHING
              RETURNING media_id
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT max(media_id) FROM batch) AS last_id
          `
        : await client<SingleBatchRow[]>`
            WITH batch AS (
              SELECT crm.media_id, crm.user_id, crm.created_at
              FROM cli_reference_media crm
              JOIN media_objects m ON m.id = crm.media_id AND m.user_id = crm.user_id
              WHERE crm.media_id > ${lastId}
                AND NOT EXISTS (
                  SELECT 1 FROM media_references r
                  WHERE r.user_id = crm.user_id
                    AND r.owner_kind = 'cli_reference'
                    AND r.owner_id = crm.media_id
                    AND r.media_id = crm.media_id
                )
              ORDER BY crm.media_id ASC
              LIMIT ${batchSize}
            ),
            inserted AS (
              INSERT INTO media_references (user_id, media_id, owner_kind, owner_id, created_at)
              SELECT b.user_id, b.media_id, 'cli_reference', b.media_id, b.created_at
              FROM batch b
              ON CONFLICT DO NOTHING
              RETURNING media_id
            )
            SELECT
              (SELECT count(*)::int FROM batch) AS scanned,
              (SELECT count(*)::int FROM inserted) AS written,
              (SELECT max(media_id) FROM batch) AS last_id
          `
    return row ?? { scanned: 0, written: 0, last_id: null }
  })
}

/**
 * 清理在在线回填与同步并发窗口中可能回插的过期 `asset`/`look` 引用边：
 * 按受影响用户串行加 `users FOR NO KEY UPDATE`（与 BFF 全局锁序一致）复核后删除，
 * 并刷新对应 `media_objects.updated_at` 保留完整宽限期。
 */
async function runPruneStaleSyncedRefsBatch(
  client: SQL,
  lastUserId: string | null,
  batchSize: number,
): Promise<{ scanned: number; deleted: number; lastUserId: string | null }> {
  const candidates =
    lastUserId === null
      ? await client<{ user_id: string }[]>`
          SELECT DISTINCT r.user_id
          FROM media_references r
          JOIN media_objects m ON m.id = r.media_id
          WHERE (
            r.owner_kind = 'asset'
            AND NOT EXISTS (
              SELECT 1
              FROM user_assets ua
              WHERE ua.user_id = r.user_id
                AND ua.id = r.owner_id
                AND ua.deleted_at IS NULL
                AND (
                  ua.image_id = m.asset_image_id
                  OR EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                    WHERE v->>'imageId' = m.asset_image_id
                  )
                )
            )
          )
          OR (
            r.owner_kind = 'look'
            AND NOT EXISTS (
              SELECT 1
              FROM user_looks ul
              WHERE ul.user_id = r.user_id
                AND ul.id = r.owner_id
                AND ul.deleted_at IS NULL
                AND (
                  ul.cover_image_id = m.asset_image_id
                  OR COALESCE(ul.reference_image_ids, '[]'::jsonb) ? m.asset_image_id
                )
            )
          )
          ORDER BY r.user_id ASC
          LIMIT ${batchSize}
        `
      : await client<{ user_id: string }[]>`
          SELECT DISTINCT r.user_id
          FROM media_references r
          JOIN media_objects m ON m.id = r.media_id
          WHERE r.user_id > ${lastUserId}
            AND (
              (
                r.owner_kind = 'asset'
                AND NOT EXISTS (
                  SELECT 1
                  FROM user_assets ua
                  WHERE ua.user_id = r.user_id
                    AND ua.id = r.owner_id
                    AND ua.deleted_at IS NULL
                    AND (
                      ua.image_id = m.asset_image_id
                      OR EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                        WHERE v->>'imageId' = m.asset_image_id
                      )
                    )
                )
              )
              OR (
                r.owner_kind = 'look'
                AND NOT EXISTS (
                  SELECT 1
                  FROM user_looks ul
                  WHERE ul.user_id = r.user_id
                    AND ul.id = r.owner_id
                    AND ul.deleted_at IS NULL
                    AND (
                      ul.cover_image_id = m.asset_image_id
                      OR COALESCE(ul.reference_image_ids, '[]'::jsonb) ? m.asset_image_id
                    )
                )
              )
            )
          ORDER BY r.user_id ASC
          LIMIT ${batchSize}
        `
  if (!candidates.length) return { scanned: 0, deleted: 0, lastUserId: null }

  let deleted = 0
  for (const { user_id: userId } of candidates) {
    const count = await client.begin(async (tx) => {
      // Lock the user row first (matching lockMediaOwner) so concurrent POST /api/sync serializes cleanly.
      const [owner] = await tx<{ id: string }[]>`
        SELECT id FROM users WHERE id = ${userId} FOR NO KEY UPDATE
      `
      if (!owner) return 0
      const [row] = await tx<{ removed: number }[]>`
        WITH stale AS (
          SELECT r.user_id, r.owner_kind, r.owner_id, r.media_id
          FROM media_references r
          JOIN media_objects m ON m.id = r.media_id
          WHERE r.user_id = ${userId}
            AND (
              (
                r.owner_kind = 'asset'
                AND NOT EXISTS (
                  SELECT 1
                  FROM user_assets ua
                  WHERE ua.user_id = r.user_id
                    AND ua.id = r.owner_id
                    AND ua.deleted_at IS NULL
                    AND (
                      ua.image_id = m.asset_image_id
                      OR EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                        WHERE v->>'imageId' = m.asset_image_id
                      )
                    )
                )
              )
              OR (
                r.owner_kind = 'look'
                AND NOT EXISTS (
                  SELECT 1
                  FROM user_looks ul
                  WHERE ul.user_id = r.user_id
                    AND ul.id = r.owner_id
                    AND ul.deleted_at IS NULL
                    AND (
                      ul.cover_image_id = m.asset_image_id
                      OR COALESCE(ul.reference_image_ids, '[]'::jsonb) ? m.asset_image_id
                    )
                )
              )
            )
        ),
        removed AS (
          DELETE FROM media_references r
          USING stale s
          WHERE r.user_id = s.user_id
            AND r.owner_kind = s.owner_kind
            AND r.owner_id = s.owner_id
            AND r.media_id = s.media_id
          RETURNING r.media_id
        ),
        touched AS (
          UPDATE media_objects m
          SET updated_at = NOW()
          WHERE m.user_id = ${userId}
            AND m.id IN (SELECT DISTINCT media_id FROM removed)
          RETURNING m.id
        )
        SELECT (SELECT count(*)::int FROM removed) AS removed
      `
      return row?.removed ?? 0
    })
    deleted += count
  }
  return {
    scanned: candidates.length,
    deleted,
    lastUserId: candidates.at(-1)?.user_id ?? null,
  }
}

/**
 * Throttled, idempotent zero-copy SQL backfill unifying `user_asset_objects` into `media_objects`
 * (`storage_scope = 'object'`) and backfilling `media_references` for live `user_assets`,
 * live `user_looks`, and `cli_reference_media`, followed by pruning any stale synced references.
 * Safe to re-run or interrupt at any batch boundary; bounded `maxBatches` slices always advance.
 */
export async function backfillAssetMedia(
  client: SQL,
  options: BackfillAssetMediaOptions = {},
): Promise<BackfillAssetMediaResult> {
  const batchSize = options.batchSize ?? 1000
  const delayMs = options.delayMs ?? 50
  const maxBatches = options.maxBatches
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
    throw new RangeError(`batchSize must be an integer between 1 and 10000, got ${batchSize}`)
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(`delayMs must be >= 0, got ${delayMs}`)
  }
  if (maxBatches !== undefined && (!Number.isInteger(maxBatches) || maxBatches < 1)) {
    throw new RangeError(`maxBatches must be a positive integer, got ${maxBatches}`)
  }

  let batches = 0
  let objectsScanned = 0
  let objectsWritten = 0
  let assetRefsScanned = 0
  let assetRefsWritten = 0
  let lookRefsScanned = 0
  let lookRefsWritten = 0
  let cliRefsScanned = 0
  let cliRefsWritten = 0
  let staleRefsPruned = 0

  const canContinue = () => maxBatches === undefined || batches < maxBatches
  const throttle = async () => {
    if (delayMs > 0 && canContinue()) {
      await Bun.sleep(delayMs)
    }
  }
  const makeResult = (completed: boolean): BackfillAssetMediaResult => ({
    batches,
    objectsScanned,
    objectsWritten,
    assetRefsScanned,
    assetRefsWritten,
    lookRefsScanned,
    lookRefsWritten,
    cliRefsScanned,
    cliRefsWritten,
    staleRefsPruned,
    completed,
  })

  // Phase 1: user_asset_objects -> media_objects (zero-copy metadata unification)
  let objectCursor: { userId: string; itemId: string } | null = null
  while (true) {
    if (!canContinue()) return makeResult(false)
    const row = await runAssetObjectsBatch(client, objectCursor, batchSize)
    if (row.scanned === 0) break
    batches++
    objectsScanned += row.scanned
    objectsWritten += row.written
    options.onBatch?.({
      phase: 'objects',
      batchNumber: batches,
      scanned: row.scanned,
      written: row.written,
    })
    if (row.scanned < batchSize || !row.last_user_id || !row.last_item_id) break
    objectCursor = { userId: row.last_user_id, itemId: row.last_item_id }
    await throttle()
  }

  // Phase 2: live user_assets -> media_references(owner_kind='asset')
  let assetCursor: { userId: string; itemId: string } | null = null
  while (true) {
    if (!canContinue()) return makeResult(false)
    const row = await runAssetRefsBatch(client, assetCursor, batchSize)
    if (row.scanned === 0) break
    batches++
    assetRefsScanned += row.scanned
    assetRefsWritten += row.written
    options.onBatch?.({
      phase: 'asset_refs',
      batchNumber: batches,
      scanned: row.scanned,
      written: row.written,
    })
    if (row.scanned < batchSize || !row.last_user_id || !row.last_item_id) break
    assetCursor = { userId: row.last_user_id, itemId: row.last_item_id }
    await throttle()
  }

  // Phase 3: live user_looks -> media_references(owner_kind='look')
  let lookCursor: { userId: string; itemId: string } | null = null
  while (true) {
    if (!canContinue()) return makeResult(false)
    const row = await runLookRefsBatch(client, lookCursor, batchSize)
    if (row.scanned === 0) break
    batches++
    lookRefsScanned += row.scanned
    lookRefsWritten += row.written
    options.onBatch?.({
      phase: 'look_refs',
      batchNumber: batches,
      scanned: row.scanned,
      written: row.written,
    })
    if (row.scanned < batchSize || !row.last_user_id || !row.last_item_id) break
    lookCursor = { userId: row.last_user_id, itemId: row.last_item_id }
    await throttle()
  }

  // Phase 4: cli_reference_media -> media_references(owner_kind='cli_reference')
  let cliCursor: string | null = null
  while (true) {
    if (!canContinue()) return makeResult(false)
    const row = await runCliRefsBatch(client, cliCursor, batchSize)
    if (row.scanned === 0) break
    batches++
    cliRefsScanned += row.scanned
    cliRefsWritten += row.written
    options.onBatch?.({
      phase: 'cli_refs',
      batchNumber: batches,
      scanned: row.scanned,
      written: row.written,
    })
    if (row.scanned < batchSize || !row.last_id) break
    cliCursor = row.last_id
    await throttle()
  }

  // Phase 5: prune any stale synced asset/look references left by concurrent tombstones/edits
  let staleUserCursor: string | null = null
  while (true) {
    if (!canContinue()) return makeResult(false)
    const pruned = await runPruneStaleSyncedRefsBatch(client, staleUserCursor, batchSize)
    if (pruned.scanned === 0) break
    batches++
    staleRefsPruned += pruned.deleted
    options.onBatch?.({
      phase: 'prune_stale_refs',
      batchNumber: batches,
      scanned: pruned.scanned,
      written: pruned.deleted,
    })
    if (pruned.scanned < batchSize || !pruned.lastUserId) break
    staleUserCursor = pruned.lastUserId
    await throttle()
  }

  return makeResult(true)
}

/**
 * Checks parity across legacy `user_asset_objects`, unified `media_objects`, and `media_references`
 * for live assets, looks, and CLI reference media in a single `REPEATABLE READ READ ONLY` snapshot.
 */
export async function verifyAssetMediaConsistency(
  client: SQL,
  sampleLimit = 10,
): Promise<AssetMediaConsistencyReport> {
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    throw new RangeError(`sampleLimit must be a non-negative integer, got ${sampleLimit}`)
  }
  return client.begin('isolation level repeatable read read only', async (tx) => {
    const [counts] = await tx<
      {
        total_legacy_assets: number
        total_unified_asset_media: number
        missing_asset_media_count: number
        missing_asset_ref_count: number
        missing_look_ref_count: number
        missing_cli_ref_count: number
        stale_synced_ref_count: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM user_asset_objects WHERE bytes > 0) AS total_legacy_assets,
        (
          SELECT count(*)::int
          FROM media_objects
          WHERE asset_image_id IS NOT NULL AND status <> 'deleting'
        ) AS total_unified_asset_media,
        (
          SELECT count(*)::int
          FROM user_asset_objects u
          WHERE u.bytes > 0
            AND NOT EXISTS (
              SELECT 1 FROM media_objects m
              WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
            )
        ) AS missing_asset_media_count,
        (
          SELECT count(*)::int
          FROM (
            SELECT DISTINCT ua.user_id, ua.id AS owner_id, m.id AS media_id
            FROM user_assets ua
            CROSS JOIN LATERAL (
              SELECT ua.image_id AS image_id
              WHERE ua.image_id IS NOT NULL AND ua.image_id <> ''
              UNION
              SELECT v->>'imageId' AS image_id
              FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
              WHERE v->>'imageId' IS NOT NULL AND v->>'imageId' <> ''
            ) img
            JOIN media_objects m
              ON m.user_id = ua.user_id
              AND m.asset_image_id = img.image_id
              AND m.status <> 'deleting'
            WHERE ua.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM media_references r
                WHERE r.user_id = ua.user_id
                  AND r.owner_kind = 'asset'
                  AND r.owner_id = ua.id
                  AND r.media_id = m.id
              )
          ) missing_asset_refs
        ) AS missing_asset_ref_count,
        (
          SELECT count(*)::int
          FROM (
            SELECT DISTINCT ul.user_id, ul.id AS owner_id, m.id AS media_id
            FROM user_looks ul
            CROSS JOIN LATERAL (
              SELECT ul.cover_image_id AS image_id
              WHERE ul.cover_image_id IS NOT NULL AND ul.cover_image_id <> ''
              UNION
              SELECT r AS image_id
              FROM jsonb_array_elements_text(COALESCE(ul.reference_image_ids, '[]'::jsonb)) AS r
              WHERE r <> ''
            ) img
            JOIN media_objects m
              ON m.user_id = ul.user_id
              AND m.asset_image_id = img.image_id
              AND m.status <> 'deleting'
            WHERE ul.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM media_references r
                WHERE r.user_id = ul.user_id
                  AND r.owner_kind = 'look'
                  AND r.owner_id = ul.id
                  AND r.media_id = m.id
              )
          ) missing_look_refs
        ) AS missing_look_ref_count,
        (
          SELECT count(*)::int
          FROM cli_reference_media crm
          JOIN media_objects m ON m.id = crm.media_id AND m.user_id = crm.user_id
          WHERE NOT EXISTS (
            SELECT 1 FROM media_references r
            WHERE r.user_id = crm.user_id
              AND r.owner_kind = 'cli_reference'
              AND r.owner_id = crm.media_id
              AND r.media_id = crm.media_id
          )
        ) AS missing_cli_ref_count,
        (
          SELECT count(*)::int
          FROM media_references r
          JOIN media_objects m ON m.id = r.media_id
          WHERE (
            r.owner_kind = 'asset'
            AND NOT EXISTS (
              SELECT 1
              FROM user_assets ua
              WHERE ua.user_id = r.user_id
                AND ua.id = r.owner_id
                AND ua.deleted_at IS NULL
                AND (
                  ua.image_id = m.asset_image_id
                  OR EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(COALESCE(ua.views, '[]'::jsonb)) AS v
                    WHERE v->>'imageId' = m.asset_image_id
                  )
                )
            )
          )
          OR (
            r.owner_kind = 'look'
            AND NOT EXISTS (
              SELECT 1
              FROM user_looks ul
              WHERE ul.user_id = r.user_id
                AND ul.id = r.owner_id
                AND ul.deleted_at IS NULL
                AND (
                  ul.cover_image_id = m.asset_image_id
                  OR COALESCE(ul.reference_image_ids, '[]'::jsonb) ? m.asset_image_id
                )
            )
          )
        ) AS stale_synced_ref_count
    `
    const missingAssetMediaCount = counts?.missing_asset_media_count ?? 0
    const sampleRows =
      missingAssetMediaCount > 0 && sampleLimit > 0
        ? await tx<{ key: string }[]>`
            SELECT u.user_id || ':' || u.image_id AS key
            FROM user_asset_objects u
            WHERE u.bytes > 0
              AND NOT EXISTS (
                SELECT 1 FROM media_objects m
                WHERE m.user_id = u.user_id AND m.asset_image_id = u.image_id
              )
            ORDER BY u.user_id ASC, u.image_id ASC
            LIMIT ${sampleLimit}
          `
        : []
    return {
      totalLegacyAssets: counts?.total_legacy_assets ?? 0,
      totalUnifiedAssetMedia: counts?.total_unified_asset_media ?? 0,
      missingAssetMediaCount,
      missingAssetRefCount: counts?.missing_asset_ref_count ?? 0,
      missingLookRefCount: counts?.missing_look_ref_count ?? 0,
      missingCliRefCount: counts?.missing_cli_ref_count ?? 0,
      staleSyncedRefCount: counts?.stale_synced_ref_count ?? 0,
      sampleMissingAssetImages: sampleRows.map((row) => row.key),
    }
  })
}
