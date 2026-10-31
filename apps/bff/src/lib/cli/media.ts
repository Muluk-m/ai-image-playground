import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { durableMediaStore } from '../durableMediaStore'
import { accessMedia, completeMedia, mediaSummary, reserveMedia } from '../projectMedia'
import { CliRequestError } from './envelope'
import { artifactId, parseArtifactId } from './jobs'

/** 与 `durableMediaStore` 签名有效期一致。 */
const SIGNED_URL_TTL_MS = 600_000
export const MEDIA_LIST_MAX = 100

export interface CliMedia {
  readonly media_id: string
  readonly status: string
  readonly bytes: number
  readonly content_type: string
  readonly width: number | null
  readonly height: number | null
}

function toCliMedia(summary: ReturnType<typeof mediaSummary>): CliMedia {
  return {
    media_id: summary.id,
    status: summary.status,
    bytes: summary.bytes,
    content_type: summary.contentType,
    width: summary.width,
    height: summary.height,
  }
}

/**
 * 参考图上传第一步：按内容哈希预留。同一张图传过就直接返回 ready，省掉重复上传。
 * 记进 cli_reference_media，列表只列这些，不把生成产物、对话附件混进来。
 */
export async function reserveReferenceMedia(
  userId: string,
  input: { sha256: string; bytes: number; content_type: string },
) {
  const reserved = await reserveMedia(userId, {
    sha256: input.sha256,
    bytes: input.bytes,
    contentType: input.content_type,
  })
  await db
    .insert(schema.cli_reference_media)
    .values({ media_id: reserved.id, user_id: userId, created_at: Date.now() })
    .onConflictDoNothing()
  return {
    ...toCliMedia(reserved),
    ...('uploadUrl' in reserved
      ? { upload_url: reserved.uploadUrl, upload_expires_at: reserved.expiresAt }
      : {}),
  }
}

export async function completeReferenceMedia(userId: string, mediaId: string): Promise<CliMedia> {
  await assertReferenceMedia(userId, mediaId)
  return toCliMedia(await completeMedia(userId, mediaId))
}

export async function listReferenceMedia(
  userId: string,
  options: { limit: number; cursor?: string },
): Promise<{ media: (CliMedia & { created_at: number })[]; next_cursor: string | null }> {
  const conditions: SQL[] = [
    eq(schema.cli_reference_media.user_id, userId),
    eq(schema.media_objects.status, 'ready'),
  ]
  if (options.cursor) {
    const [anchor] = await db
      .select({ createdAt: schema.cli_reference_media.created_at })
      .from(schema.cli_reference_media)
      .where(
        and(
          eq(schema.cli_reference_media.media_id, options.cursor),
          eq(schema.cli_reference_media.user_id, userId),
        ),
      )
    if (!anchor) throw new CliRequestError('INVALID_REQUEST', { message: 'unknown cursor' })
    conditions.push(
      or(
        lt(schema.cli_reference_media.created_at, anchor.createdAt),
        and(
          eq(schema.cli_reference_media.created_at, anchor.createdAt),
          lt(schema.cli_reference_media.media_id, options.cursor),
        ),
      )!,
    )
  }
  const rows = await db
    .select({ media: schema.media_objects, createdAt: schema.cli_reference_media.created_at })
    .from(schema.cli_reference_media)
    .innerJoin(
      schema.media_objects,
      eq(schema.media_objects.id, schema.cli_reference_media.media_id),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.cli_reference_media.created_at), desc(schema.cli_reference_media.media_id))
    .limit(options.limit + 1)
  const page = rows.slice(0, options.limit)
  return {
    media: page.map((row) => ({
      ...toCliMedia(mediaSummary(row.media)),
      created_at: row.createdAt,
    })),
    next_cursor: rows.length > options.limit ? page.at(-1)!.media.id : null,
  }
}

/**
 * `media:read` 只覆盖经 CLI 上传的参考图：账号里的画布上传、对话附件不因为知道 id 就能取到。
 * 生成结果走 artifacts 接口。
 */
async function assertReferenceMedia(userId: string, mediaId: string): Promise<void> {
  const [row] = await db
    .select({ id: schema.cli_reference_media.media_id })
    .from(schema.cli_reference_media)
    .where(
      and(
        eq(schema.cli_reference_media.media_id, mediaId),
        eq(schema.cli_reference_media.user_id, userId),
      ),
    )
    .limit(1)
  if (!row) throw new CliRequestError('NOT_FOUND')
}

/** 元数据不带下载地址：签名链接只在明确要下载时才发，免得写进 Agent 的上下文。 */
export async function getMedia(userId: string, mediaId: string): Promise<CliMedia> {
  await assertReferenceMedia(userId, mediaId)
  return toCliMedia(await accessMedia(userId, mediaId))
}

export async function mediaDownload(userId: string, mediaId: string) {
  await assertReferenceMedia(userId, mediaId)
  const access = await accessMedia(userId, mediaId)
  return {
    media_id: access.id,
    content_type: access.contentType,
    bytes: access.bytes,
    download_url: access.originalUrl,
    expires_at: access.expiresAt,
  }
}

async function ownedArtifact(userId: string, id: string) {
  const parsed = parseArtifactId(id)
  if (!parsed) throw new CliRequestError('NOT_FOUND')
  const [row] = await db
    .select({ media: schema.media_objects })
    .from(schema.generation_images)
    .innerJoin(
      schema.generation_records,
      eq(schema.generation_records.id, schema.generation_images.generation_id),
    )
    .innerJoin(schema.media_objects, eq(schema.media_objects.id, schema.generation_images.media_id))
    .where(
      and(
        eq(schema.generation_images.generation_id, parsed.taskId),
        eq(schema.generation_images.role, 'output'),
        eq(schema.generation_images.position, parsed.position),
        eq(schema.generation_records.user_id, userId),
        eq(schema.generation_records.status, 'completed'),
        isNull(schema.generation_records.deleted_at),
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
      ),
    )
    .limit(1)
  if (!row?.media.object_key) throw new CliRequestError('NOT_FOUND')
  return { ...parsed, media: row.media, objectKey: row.media.object_key }
}

export async function getArtifact(userId: string, id: string) {
  const { taskId, position, media } = await ownedArtifact(userId, id)
  return {
    artifact_id: artifactId(taskId, position),
    job_id: taskId,
    ...toCliMedia(mediaSummary(media)),
  }
}

/** 每次调用都重新签名：链接过期了按同一个 id 再取一次即可，不影响云端任务。 */
export async function artifactDownload(userId: string, id: string) {
  const { taskId, position, media, objectKey } = await ownedArtifact(userId, id)
  return {
    artifact_id: artifactId(taskId, position),
    content_type: media.content_type,
    bytes: media.bytes,
    download_url: durableMediaStore().sign(objectKey, 'GET'),
    expires_at: Date.now() + SIGNED_URL_TTL_MS,
  }
}
