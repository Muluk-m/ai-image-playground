import type { LookAssemblyAsset } from '@image-playground/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema } from '../db/client'

/**
 * 出图要用到的模板那几项。自建模板来自 `user_looks`，预置模板来自技能目录里带模板标记的技能；
 * 两者的差别只剩参考图从哪儿读——`skillName` 在场时参考图 id 是技能目录里的文件名。
 */
export interface BatchLook {
  readonly body: string
  readonly slotCount: number
  readonly model: string
  readonly size: string
  readonly referenceImageIds: readonly string[]
  readonly skillName?: string
}

export async function readUserLook(userId: string, lookId: string): Promise<BatchLook | null> {
  const [row] = await db
    .select({
      body: schema.user_looks.body,
      slotCount: schema.user_looks.slot_count,
      model: schema.user_looks.model,
      size: schema.user_looks.size,
      referenceImageIds: schema.user_looks.reference_image_ids,
    })
    .from(schema.user_looks)
    .where(
      and(
        eq(schema.user_looks.user_id, userId),
        eq(schema.user_looks.id, lookId),
        isNull(schema.user_looks.deleted_at),
      ),
    )
    .limit(1)
  if (!row?.body) return null
  return {
    body: row.body,
    slotCount: row.slotCount ?? 1,
    model: row.model ?? '',
    size: row.size ?? '',
    referenceImageIds: row.referenceImageIds ?? [],
  }
}

/** 旧素材没有 `views`，封面就是它唯一的一张视角。 */
export async function readLookAssemblyAssets(
  userId: string,
  assetIds: readonly string[],
): Promise<Map<string, LookAssemblyAsset>> {
  const rows = await db
    .select({
      id: schema.user_assets.id,
      name: schema.user_assets.name,
      imageId: schema.user_assets.image_id,
      views: schema.user_assets.views,
    })
    .from(schema.user_assets)
    .where(
      and(
        eq(schema.user_assets.user_id, userId),
        inArray(schema.user_assets.id, [...assetIds]),
        isNull(schema.user_assets.deleted_at),
      ),
    )
  const assets = new Map<string, LookAssemblyAsset>()
  for (const row of rows) {
    const views = row.views?.length
      ? row.views
      : row.imageId
        ? [{ imageId: row.imageId, label: 'none', source: 'upload' }]
        : []
    assets.set(row.id, { id: row.id, name: row.name ?? '', views })
  }
  return assets
}
