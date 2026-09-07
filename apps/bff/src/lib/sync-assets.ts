import type { SyncAssetQuotaErrorCode, SyncAssetUploadResult } from '@image-playground/shared'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { objectStore } from './objectStore'
import type { BffTransaction } from './private-overlay'

export interface StoredAssetImage {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

export type AssetUploadAccepted = SyncAssetUploadResult & { readonly ok: true }

export interface AssetUploadRejected {
  readonly ok: false
  readonly error: SyncAssetQuotaErrorCode
  readonly limit: number
}

export function assetObjectKey(userId: string, imageId: string): string {
  return `users/${userId}/assets/${imageId}`
}

async function totalBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.user_asset_objects.bytes}), 0)::int` })
    .from(schema.user_asset_objects)
    .where(eq(schema.user_asset_objects.user_id, userId))
  return row?.total ?? 0
}

/**
 * 先写对象再落账：反过来会让同步接受一条图片其实没上传的素材记录。落账失败留下的孤儿对象
 * 键是内容哈希，下一次同 `imageId` 上传直接复用。
 */
export async function storeAssetImage(
  userId: string,
  imageId: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<AssetUploadAccepted | AssetUploadRejected> {
  const imageLimit = config.operator.quotas['sync:asset-image-bytes']
  const userLimit = config.operator.quotas['sync:user-asset-bytes']
  if (bytes.byteLength > imageLimit) {
    return { ok: false, error: 'asset_image_too_large', limit: imageLimit }
  }

  const used = await totalBytes(userId)
  const [existing] = await db
    .select({ bytes: schema.user_asset_objects.bytes })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        eq(schema.user_asset_objects.image_id, imageId),
      ),
    )
  if (existing) return { ok: true, imageId, bytes: existing.bytes, totalBytes: used }

  if (used + bytes.byteLength > userLimit) {
    return { ok: false, error: 'asset_storage_quota_exceeded', limit: userLimit }
  }

  await objectStore().write(assetObjectKey(userId, imageId), bytes, contentType)
  await db
    .insert(schema.user_asset_objects)
    .values({
      user_id: userId,
      image_id: imageId,
      bytes: bytes.byteLength,
      content_type: contentType,
      created_at: Date.now(),
    })
    .onConflictDoNothing()
  return { ok: true, imageId, bytes: bytes.byteLength, totalBytes: used + bytes.byteLength }
}

export async function readAssetImage(
  userId: string,
  imageId: string,
): Promise<StoredAssetImage | null> {
  const [row] = await db
    .select({ content_type: schema.user_asset_objects.content_type })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        eq(schema.user_asset_objects.image_id, imageId),
      ),
    )
  if (!row) return null
  return {
    bytes: await objectStore().read(assetObjectKey(userId, imageId)),
    contentType: row.content_type,
  }
}

/** 同步接受素材记录的前提：这里报告的就是「图片本体已在服务端」。 */
export async function uploadedImageIds(
  tx: BffTransaction,
  userId: string,
  imageIds: readonly string[],
): Promise<Set<string>> {
  if (!imageIds.length) return new Set()
  const rows = await tx
    .select({ image_id: schema.user_asset_objects.image_id })
    .from(schema.user_asset_objects)
    .where(
      and(
        eq(schema.user_asset_objects.user_id, userId),
        inArray(schema.user_asset_objects.image_id, [...imageIds]),
      ),
    )
  return new Set(rows.map((row) => row.image_id))
}
