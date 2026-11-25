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
 * 读取素材图的统一账本元信息（仅读 `media_objects`；`status !== 'ready'` 一律按不存在返回）。
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
  if (!unified || unified.status !== 'ready') return null
  return {
    mediaId: unified.id,
    bytes: unified.bytes,
    contentType: unified.contentType,
    objectKey: unified.objectKey ?? assetObjectKey(userId, imageId),
    storageScope: unified.storageScope,
  }
}

/**
 * 先写对象再落账：反过来会让同步接受一条图片其实没上传的素材记录。落账失败留下的孤儿对象
 * 键是内容哈希，下一次同 `imageId` 上传直接复用。
 * 全量回填完成后仅写统一账本 `media_objects(storage_scope='object')`，不再双写 `user_asset_objects`。
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
      const [used, [existingMedia]] = await Promise.all([
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
  const unifiedRows = await tx
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
    )
  const uploaded = new Set<string>()
  for (const row of unifiedRows) {
    if (row.imageId && row.status === 'ready') uploaded.add(row.imageId)
  }
  return uploaded
}

/**
 * 查询给定素材图在统一 `media_objects` 账本中的就绪记录 ID，供 `sync.ts` 写入 `media_references`。
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
  for (const row of existing) {
    if (row.imageId && row.status === 'ready') resolved.set(row.imageId, row.id)
  }
  return resolved
}
