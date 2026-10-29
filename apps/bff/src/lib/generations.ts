import {
  type GenerationDetail,
  type GenerationPage,
  projectArtifactId,
} from '@image-playground/shared'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

const table = schema.generation_records
const columns = {
  id: table.id,
  source: table.source,
  provider: table.provider,
  model: table.model,
  status: table.status,
  archiveStatus: table.archive_status,
  errorType: table.error_type,
  createdAt: table.created_at,
  startedAt: table.started_at,
  completedAt: table.completed_at,
  revision: sql<string>`${table.revision}::text`,
  prompt: table.prompt,
  parameters: table.parameters,
  actualParameters: table.actual_parameters,
}
export type GenerationCursor = { createdAt: number; id: string }

/**
 * 实际尺寸以落库原件的真实像素为准。
 *
 * `actual_parameters` 只抄得到上游自己报的 size：OpenAI 带，Gemini / Grok 不带，于是卡片回落到请求里
 * 那个 1024x1024（Gemini 压根不按它出图）。像素在媒体表里本来就有，读的时候覆盖上去，
 * 历史记录也一并对了，不用回填。没有像素（未归档、旧媒体）时保留上游报的值。
 */
export function withMeasuredSize<T extends { size?: string }>(
  actual: T,
  image: { width: number | null; height: number | null } | null | undefined,
): T {
  if (!image?.width || !image.height) return actual
  return { ...actual, size: `${image.width}x${image.height}` }
}
export async function listGenerations(
  userId: string,
  limit: number,
  cursor?: GenerationCursor,
): Promise<GenerationPage> {
  const rows = await db
    .select(columns)
    .from(table)
    .where(
      and(
        eq(table.user_id, userId),
        isNull(table.deleted_at),
        cursor
          ? or(
              lt(table.created_at, cursor.createdAt),
              and(eq(table.created_at, cursor.createdAt), lt(table.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(table.created_at), desc(table.id))
    .limit(limit + 1)
  const selected = rows.slice(0, limit)
  // 封面、参考图与遮罩一趟查出来：卡片要封面，复用要参考图和遮罩，多一次往返用户就多等一次。
  // 产出原件不在这里——那是展开详情才看的东西，整页查出来白花带宽。
  const images = selected.length
    ? await db
        .select({
          generationId: schema.generation_images.generation_id,
          role: schema.generation_images.role,
          index: schema.generation_images.position,
          mediaId: schema.media_objects.id,
          width: schema.media_objects.width,
          height: schema.media_objects.height,
          contentType: schema.media_objects.content_type,
        })
        .from(schema.generation_images)
        .innerJoin(
          schema.media_objects,
          eq(schema.generation_images.media_id, schema.media_objects.id),
        )
        .where(
          and(
            inArray(
              schema.generation_images.generation_id,
              selected.map((row) => row.id),
            ),
            or(
              // 封面取第一张没被单独删掉的产出（删了第 0 张，封面顺延到下一张）。
              and(
                eq(schema.generation_images.role, 'output'),
                isNull(schema.generation_images.deleted_at),
                sql`${schema.generation_images.position} = (
                  SELECT min(cover.position) FROM ${schema.generation_images} cover
                  WHERE cover.generation_id = ${schema.generation_images.generation_id}
                    AND cover.role = 'output' AND cover.deleted_at IS NULL
                )`,
              ),
              inArray(schema.generation_images.role, ['input', 'mask']),
            ),
            eq(schema.media_objects.user_id, userId),
          ),
        )
        .orderBy(schema.generation_images.position)
    : []
  const items = selected.map((row) => {
    const own = images.filter((image) => image.generationId === row.id)
    const pick = (role: 'input' | 'mask' | 'output') =>
      own
        .filter((image) => image.role === role)
        .map(({ generationId: _id, role: _role, ...image }) => image)
    const [cover] = pick('output')
    return {
      ...row,
      actualParameters: withMeasuredSize(row.actualParameters, cover),
      cover: cover ? { ...cover, artifactId: projectArtifactId(row.id, cover.index) } : null,
      inputs: pick('input'),
      mask: pick('mask')[0] ?? null,
    }
  })
  const last = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString(
            'base64url',
          )
        : null,
  }
}
export async function readGeneration(
  userId: string,
  id: string,
): Promise<GenerationDetail | undefined> {
  const [record] = await db
    .select(columns)
    .from(table)
    .where(and(eq(table.user_id, userId), eq(table.id, id), isNull(table.deleted_at)))
  if (!record) return undefined
  const images = await db
    .select({
      role: schema.generation_images.role,
      index: schema.generation_images.position,
      mediaId: schema.media_objects.id,
      width: schema.media_objects.width,
      height: schema.media_objects.height,
      contentType: schema.media_objects.content_type,
    })
    .from(schema.generation_images)
    .innerJoin(schema.media_objects, eq(schema.generation_images.media_id, schema.media_objects.id))
    .where(
      and(
        eq(schema.generation_images.generation_id, id),
        eq(schema.media_objects.user_id, userId),
        isNull(schema.generation_images.deleted_at),
      ),
    )
    .orderBy(schema.generation_images.position)
  const byRole = (role: 'input' | 'mask' | 'output') =>
    images
      .filter((image) => image.role === role)
      .map(({ role: _role, ...image }) => ({
        ...image,
        ...(role === 'output' ? { artifactId: projectArtifactId(id, image.index) } : {}),
      }))
  const outputs = byRole('output')
  return {
    ...record,
    actualParameters: withMeasuredSize(record.actualParameters, outputs[0]),
    outputs,
    cover: outputs[0] ?? null,
    inputs: byRole('input'),
    mask: byRole('mask')[0] ?? null,
  }
}

/**
 * 软删一条生成记录：只有本人未删除的记录会被标记，返回是否真的改到了行。
 * 媒体对象留在原地——它可能被画布或别的记录引用，回收由媒体侧的保留策略负责。
 */
export async function deleteGeneration(userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .update(table)
    .set({ deleted_at: Date.now() })
    .where(and(eq(table.user_id, userId), eq(table.id, id), isNull(table.deleted_at)))
    .returning({ id: table.id })
  return deleted.length > 0
}

export type GenerationOutputDeletion = 'output_deleted' | 'generation_deleted' | 'not_found'

/**
 * 软删一条生成记录里的一张产出（「我的作品」多图任务只删一张）。位置号不重排：画布、对话和
 * `/api/result/:id/:index` 仍按原位置找图，原件也留在原地。删到最后一张时整条记录一并软删，
 * 作品页不会剩一张没有图的空卡。只认本人、未删除、已完成记录里尚未删除的那一张。
 */
export async function deleteGenerationOutput(
  userId: string,
  id: string,
  position: number,
): Promise<GenerationOutputDeletion> {
  const images = schema.generation_images
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.user_id, userId), eq(table.id, id), isNull(table.deleted_at)))
      .for('update')
    if (!record) return 'not_found'
    const now = Date.now()
    const deleted = await tx
      .update(images)
      .set({ deleted_at: now })
      .where(
        and(
          eq(images.generation_id, id),
          eq(images.role, 'output'),
          eq(images.position, position),
          isNull(images.deleted_at),
        ),
      )
      .returning({ position: images.position })
    if (!deleted.length) return 'not_found'
    const [left] = await tx
      .select({ position: images.position })
      .from(images)
      .where(
        and(eq(images.generation_id, id), eq(images.role, 'output'), isNull(images.deleted_at)),
      )
      .limit(1)
    if (left) return 'output_deleted'
    await tx.update(table).set({ deleted_at: now }).where(eq(table.id, id))
    return 'generation_deleted'
  })
}
