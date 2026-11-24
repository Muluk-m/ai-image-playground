import { readUserAssetBytes } from '@image-playground/read-models'
import type { SyncAssetQuotaError, SyncAssetUploadResult } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'
import { objectStore, readObjectWithinLimit } from './objectStore'
import type { BffTransaction } from './private-overlay'
import { lockMediaOwner, mediaUsage } from './projectMedia'

export interface StoredAssetImage {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

export interface AssetImageMeta {
  readonly mediaId: string | null
  readonly bytes: number
  readonly contentType: string
  readonly objectKey: string
  readonly storageScope: 'durable' | 'object'
}

export interface AssetUploadAccepted {
  readonly ok: true
  readonly result: SyncAssetUploadResult
}

export type AssetUploadRejected =
  | (SyncAssetQuotaError & { readonly ok: false })
  | { readonly ok: false; readonly error: 'asset_image_empty' }
  | { readonly ok: false; readonly error: 'asset_media_deleting' }

/** 对象键的唯一出处；孤儿清扫按 `assetOwnerPrefix(userId)` 反过来收走一个用户的全部对象。 */
export const ASSET_OBJECT_ROOT = 'users/'

/** 同步素材在统一 `media_objects` 账本里的命名空间前缀，避免与真实 64 位 hex sha256 碰撞。 */
export const ASSET_MEDIA_SHA_PREFIX = 'asset:'

export function assetMediaSha256(imageId: string): string {
  return `${ASSET_MEDIA_SHA_PREFIX}${imageId}`
}

export function assetOwnerPrefix(userId: string): string {
  return `${ASSET_OBJECT_ROOT}${userId}/`
}

export function assetObjectKey(userId: string, imageId: string): string {
  return `${assetOwnerPrefix(userId)}assets/${imageId}`
}

export function assetImageByteLimit(): number {
  return config.operator.quotas['sync:asset-image-bytes']
}

function totalBytes(tx: BffTransaction, userId: string): Promise<number> {
  return readUserAssetBytes(tx, userId)
}

/**
 * 读取素材图的统一账本元信息：优先读 `media_objects`，尚未回填的旧记录回退 `user_asset_objects`。
 * 若统一账本行已进入 `deleting`，一律按不存在返回，不回退到旧镜像表。
 */
export async function findAssetImageMeta(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  imageId: string,
  options?: { readonly lockShare?: boolean },
): Promise<AssetImageMeta | null> {
  const baseUnified = executor
    .select({
      id: schema.media_objects.id,
      status: schema.media_objects.status,
      bytes: schema.media_objects.bytes,
      contentType: schema.media_objects.content_type,
      objectKey: schema.media_objects.object_key,
      storageScope: schema.media_objects.storage_scope,
    })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.asset_image_id, imageId),
      ),
    )
  const [unified] = options?.lockShare
    ? await baseUnified.for('share').limit(1)
    : await baseUnified.limit(1)
  if (unified) {
    if (unified.status !== 'ready') return null
    return {
      mediaId: unified.id,
      bytes: unified.bytes,
      contentType: unified.contentType,
      objectKey: unified.objectKey ?? assetObjectKey(userId, imageId),
      storageScope: unified.storageScope,
    }
  }
  const [legacy] = await executor
    .select({
      bytes: schema.user_asset_objects.bytes,
      contentType: schema.user_asset_objects.content_type,
    })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        eq(schema.user_asset_objects.image_id, imageId),
      ),
    )
    .limit(1)
  if (!legacy) return null
  return {
    mediaId: null,
    bytes: legacy.bytes,
    contentType: legacy.contentType,
    objectKey: assetObjectKey(userId, imageId),
    storageScope: 'object',
  }
}

/**
 * 先写对象再落账：反过来会让同步接受一条图片其实没上传的素材记录。落账失败留下的孤儿对象
 * 键是内容哈希，下一次同 `imageId` 上传直接复用。
 * Expand 期间同事务双写 `media_objects(storage_scope='object', reserved_bytes=0)` 与 `user_asset_objects`：
 * 滚动发布与仅回滚 BFF 时旧代 BFF 不会双计配额，新版 `mediaUsage` 与 `readUserAssetBytes` 单语句去重。
 */
export async function storeAssetImage(
  userId: string,
  imageId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<AssetUploadAccepted | AssetUploadRejected> {
  if (bytes.byteLength === 0) {
    return { ok: false, error: 'asset_image_empty' }
  }
  const imageLimit = assetImageByteLimit()
  const userLimit = config.operator.quotas['sync:user-asset-bytes']
  if (bytes.byteLength > imageLimit) {
    return { ok: false, error: 'asset_image_too_large', limit: imageLimit }
  }

  const account = (publish: boolean): Promise<AssetUploadAccepted | AssetUploadRejected | null> =>
    db.transaction(async (tx) => {
      await lockMediaOwner(tx, userId)
      const [used, [existingMedia], [existingLegacy]] = await Promise.all([
        totalBytes(tx, userId),
        tx
          .select({
            id: schema.media_objects.id,
            status: schema.media_objects.status,
            bytes: schema.media_objects.bytes,
          })
          .from(schema.media_objects)
          .where(
            and(
              eq(schema.media_objects.user_id, userId),
              eq(schema.media_objects.asset_image_id, imageId),
            ),
          )
          .limit(1),
        tx
          .select({ bytes: schema.user_asset_objects.bytes })
          .from(schema.user_asset_objects)
          .where(
            and(
              eq(schema.user_asset_objects.user_id, userId),
              eq(schema.user_asset_objects.image_id, imageId),
            ),
          )
          .limit(1),
      ])
      if (existingMedia?.status === 'deleting') {
        // 禁止在 deleting 窗口对同一确定性 R2 键并发 PUT，避免对象刚写完即被清理删掉。
        return { ok: false, error: 'asset_media_deleting' }
      }
      if (existingMedia?.status === 'ready') {
        // 重传命中既有 ready 行时续期 updated_at，防止刚传完、POST /api/sync 尚未到达就被回收。
        await tx
          .update(schema.media_objects)
          .set({ updated_at: Date.now() })
          .where(eq(schema.media_objects.id, existingMedia.id))
        return { ok: true, result: { imageId, bytes: existingMedia.bytes, totalBytes: used } }
      }
      if (!existingMedia && existingLegacy) {
        // 迁移期重传命中尚未回填的旧账本行：在用户锁内惰性物化为统一行并续期 updated_at，
        // 避免随后在线回填或回收在 POST /api/sync 到达前误删。
        if (existingLegacy.bytes > 0) {
          await ensureAssetMediaIds(tx, userId, [imageId])
          await tx
            .update(schema.media_objects)
            .set({ updated_at: Date.now() })
            .where(
              and(
                eq(schema.media_objects.user_id, userId),
                eq(schema.media_objects.asset_image_id, imageId),
                eq(schema.media_objects.status, 'ready'),
              ),
            )
        }
        return { ok: true, result: { imageId, bytes: existingLegacy.bytes, totalBytes: used } }
      }

      if (
        used + bytes.byteLength > userLimit ||
        (await mediaUsage(tx, userId)) + bytes.byteLength >
          config.operator.quotas['sync:user-media-bytes']
      ) {
        return { ok: false, error: 'asset_storage_quota_exceeded', limit: userLimit }
      }

      if (!publish) return null
      const now = Date.now()
      const key = assetObjectKey(userId, imageId)
      await tx
        .insert(schema.media_objects)
        .values({
          id: crypto.randomUUID(),
          user_id: userId,
          sha256: assetMediaSha256(imageId),
          bytes: bytes.byteLength,
          content_type: contentType,
          status: 'ready',
          attachment_managed: false,
          attachment_lease_until: null,
          // Expand 期间保留 reserved_bytes = 0，使滚动发布期间的旧代 BFF 不重复计入 user_asset_objects。
          reserved_bytes: 0,
          staging_key: key,
          object_key: key,
          preview_key: null,
          preview_bytes: 0,
          asset_image_id: imageId,
          storage_scope: 'object',
          width: null,
          height: null,
          expires_at: now,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
      await tx
        .insert(schema.user_asset_objects)
        .values({
          user_id: userId,
          image_id: imageId,
          bytes: bytes.byteLength,
          content_type: contentType,
          created_at: now,
        })
        .onConflictDoNothing()
      return {
        ok: true,
        result: { imageId, bytes: bytes.byteLength, totalBytes: used + bytes.byteLength },
      }
    })
  const existingOrRejected = await account(false)
  if (existingOrRejected) return existingOrRejected
  await objectStore().write(assetObjectKey(userId, imageId), bytes, contentType)
  // Recheck capacity under the owner lock; rejected writes remain unreferenced for orphan cleanup.
  return (await account(true))!
}

export async function readAssetImage(
  userId: string,
  imageId: string,
  maxBytes?: number,
): Promise<StoredAssetImage | null> {
  const meta = await findAssetImageMeta(db, userId, imageId)
  if (!meta) return null
  const store = meta.storageScope === 'durable' ? durableMediaStore() : objectStore()
  return {
    bytes:
      maxBytes === undefined
        ? await store.read(meta.objectKey)
        : await readObjectWithinLimit(store, meta.objectKey, maxBytes),
    contentType: meta.contentType,
  }
}

/** 同步接受素材记录的前提：这里报告的就是「图片本体已在服务端」。 */
export async function uploadedImageIds(
  tx: BffTransaction,
  userId: string,
  imageIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(imageIds.filter((id) => id.length > 0))]
  if (!unique.length) return new Set()
  const [unifiedRows, legacyRows] = await Promise.all([
    tx
      .select({
        imageId: schema.media_objects.asset_image_id,
        status: schema.media_objects.status,
      })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, userId),
          inArray(schema.media_objects.asset_image_id, unique),
        ),
      ),
    tx
      .select({ imageId: schema.user_asset_objects.image_id })
      .from(schema.user_asset_objects)
      .where(
        and(
          eq(schema.user_asset_objects.user_id, userId),
          inArray(schema.user_asset_objects.image_id, unique),
        ),
      ),
  ])
  const knownInUnified = new Map<string, string>()
  for (const row of unifiedRows) {
    if (row.imageId) knownInUnified.set(row.imageId, row.status)
  }
  const uploaded = new Set<string>()
  for (const [imageId, status] of knownInUnified) {
    if (status === 'ready') uploaded.add(imageId)
  }
  for (const row of legacyRows) {
    if (!knownInUnified.has(row.imageId)) uploaded.add(row.imageId)
  }
  return uploaded
}

/**
 * 在持有用户媒体锁（`lockMediaOwner`）的事务内，确保给定素材图都在 `media_objects` 中有就绪记录，
 * 以便 `sync.ts` 写入 `media_references` 时满足外键约束。尚未回填的旧行按零搬运方式惰性物化。
 */
export async function ensureAssetMediaIds(
  tx: BffTransaction,
  userId: string,
  imageIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(imageIds.filter((id) => id.length > 0))]
  if (!unique.length) return new Map()
  const existing = await tx
    .select({
      id: schema.media_objects.id,
      imageId: schema.media_objects.asset_image_id,
      status: schema.media_objects.status,
    })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        inArray(schema.media_objects.asset_image_id, unique),
      ),
    )
  const resolved = new Map<string, string>()
  const known = new Set<string>()
  for (const row of existing) {
    if (!row.imageId) continue
    known.add(row.imageId)
    if (row.status === 'ready') resolved.set(row.imageId, row.id)
  }
  const missing = unique.filter((id) => !known.has(id))
  if (!missing.length) return resolved

  const legacyRows = await tx
    .select({
      imageId: schema.user_asset_objects.image_id,
      bytes: schema.user_asset_objects.bytes,
      contentType: schema.user_asset_objects.content_type,
      createdAt: schema.user_asset_objects.created_at,
    })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        inArray(schema.user_asset_objects.image_id, missing),
      ),
    )
  const validLegacyRows = legacyRows.filter((row) => row.bytes > 0)
  if (!validLegacyRows.length) return resolved

  const now = Date.now()
  await tx
    .insert(schema.media_objects)
    .values(
      validLegacyRows.map((row) => {
        const key = assetObjectKey(userId, row.imageId)
        return {
          id: crypto.randomUUID(),
          user_id: userId,
          sha256: assetMediaSha256(row.imageId),
          bytes: row.bytes,
          content_type: row.contentType,
          status: 'ready' as const,
          attachment_managed: false,
          attachment_lease_until: null,
          reserved_bytes: 0,
          staging_key: key,
          object_key: key,
          preview_key: null,
          preview_bytes: 0,
          asset_image_id: row.imageId,
          storage_scope: 'object' as const,
          width: null,
          height: null,
          expires_at: row.createdAt,
          created_at: row.createdAt,
          updated_at: now,
        }
      }),
    )
    .onConflictDoNothing()

  const materialized = await tx
    .select({
      id: schema.media_objects.id,
      imageId: schema.media_objects.asset_image_id,
    })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        inArray(
          schema.media_objects.asset_image_id,
          validLegacyRows.map((row) => row.imageId),
        ),
        eq(schema.media_objects.status, 'ready'),
      ),
    )
  for (const row of materialized) {
    if (row.imageId) resolved.set(row.imageId, row.id)
  }
  return resolved
}
