import { parseProjectArtifactId, projectArtifactId } from '@image-playground/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { cliApiRoutes, cliSuccess } from '../lib/cli-api'
import { durableMediaStore } from '../lib/durableMediaStore'
import { accessMedia, completeMedia, MediaError, reserveMedia } from '../lib/projectMedia'

type CliMediaAccess = {
  media_id: string
  status: string
  bytes: number
  content_type: string
  width: number | null
  height: number | null
  original_url: string
  preview_url: string
  expires_at: number
}

function mapMediaAccess(value: {
  id: string
  status: string
  bytes: number
  contentType: string
  width: number | null
  height: number | null
  originalUrl: string
  previewUrl: string
  expiresAt: number
}): CliMediaAccess {
  return {
    media_id: value.id,
    status: value.status,
    bytes: value.bytes,
    content_type: value.contentType,
    width: value.width,
    height: value.height,
    original_url: value.originalUrl,
    preview_url: value.previewUrl,
    expires_at: value.expiresAt,
  }
}

async function artifactAccess(userId: string, artifactId: string) {
  const parsed = parseProjectArtifactId(artifactId)
  if (!parsed) throw new MediaError(404, 'artifact_not_found')
  const [row] = await db
    .select({
      mediaId: schema.media_objects.id,
      bytes: schema.media_objects.bytes,
      contentType: schema.media_objects.content_type,
      width: schema.media_objects.width,
      height: schema.media_objects.height,
      objectKey: schema.media_objects.object_key,
    })
    .from(schema.generation_images)
    .innerJoin(
      schema.generation_records,
      eq(schema.generation_records.id, schema.generation_images.generation_id),
    )
    .innerJoin(schema.media_objects, eq(schema.media_objects.id, schema.generation_images.media_id))
    .where(
      and(
        eq(schema.generation_images.generation_id, parsed.generationId),
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
  if (!row?.objectKey) throw new MediaError(404, 'artifact_not_found')
  return {
    artifact_id: projectArtifactId(parsed.generationId, parsed.position),
    media_id: row.mediaId,
    bytes: row.bytes,
    content_type: row.contentType,
    width: row.width,
    height: row.height,
    download_url: durableMediaStore().sign(row.objectKey, 'GET'),
    expires_at: Date.now() + 600_000,
  }
}

const idParams = t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) })

/** External CLI reference-media and generated-artifact access routes. */
export const cliMediaRoutes = new Elysia({ name: 'cli-media-routes' })
  .use(cliApiRoutes())
  .post(
    '/v1/media',
    async ({ body, cliUser }) => {
      const reserved = await reserveMedia(cliUser.id, {
        sha256: body.sha256,
        bytes: body.bytes,
        contentType: body.content_type,
      })
      if (reserved.status === 'ready')
        return cliSuccess({
          media_id: reserved.id,
          status: reserved.status,
          bytes: reserved.bytes,
          content_type: reserved.contentType,
          width: reserved.width,
          height: reserved.height,
        })
      if (!('uploadUrl' in reserved) || !reserved.uploadUrl)
        return cliSuccess({ media_id: reserved.id, status: reserved.status })
      return cliSuccess({
        media_id: reserved.id,
        upload_url: reserved.uploadUrl,
        expires_at: 'expiresAt' in reserved ? reserved.expiresAt : undefined,
        status: reserved.status,
      })
    },
    {
      body: t.Object({
        sha256: t.String({ pattern: '^[a-f0-9]{64}$' }),
        bytes: t.Integer({ minimum: 1, maximum: 100_000_000 }),
        content_type: t.String({ pattern: '^image/(png|jpeg|webp)$' }),
      }),
    },
  )
  .post(
    '/v1/media/:id/complete',
    async ({ params, cliUser }) => {
      const value = await completeMedia(cliUser.id, params.id)
      return cliSuccess({ media_id: value.id, ...value })
    },
    { params: idParams },
  )
  .get(
    '/v1/media',
    async ({ query, cliUser }) => {
      const limit = query.limit ?? 50
      const rows = await db
        .select({
          id: schema.media_objects.id,
          status: schema.media_objects.status,
          bytes: schema.media_objects.bytes,
          content_type: schema.media_objects.content_type,
          width: schema.media_objects.width,
          height: schema.media_objects.height,
          created_at: schema.media_objects.created_at,
        })
        .from(schema.media_objects)
        .where(
          and(
            eq(schema.media_objects.user_id, cliUser.id),
            eq(schema.media_objects.status, 'ready'),
          ),
        )
        .orderBy(desc(schema.media_objects.created_at), desc(schema.media_objects.id))
        .limit(limit)
      return cliSuccess({
        media: rows.map((row) => ({
          media_id: row.id,
          status: row.status,
          bytes: row.bytes,
          content_type: row.content_type,
          width: row.width,
          height: row.height,
          created_at: row.created_at,
        })),
      })
    },
    { query: t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })) }) },
  )
  .get(
    '/v1/media/:id',
    async ({ params, cliUser }) => {
      return cliSuccess(mapMediaAccess(await accessMedia(cliUser.id, params.id)))
    },
    { params: idParams },
  )
  .get(
    '/v1/media/:id/download',
    async ({ params, cliUser }) => {
      const value = mapMediaAccess(await accessMedia(cliUser.id, params.id))
      return cliSuccess({
        media_id: value.media_id,
        download_url: value.original_url,
        content_type: value.content_type,
        bytes: value.bytes,
        expires_at: value.expires_at,
      })
    },
    { params: idParams },
  )
  .get(
    '/v1/artifacts/:id',
    async ({ params, cliUser }) => {
      return cliSuccess(await artifactAccess(cliUser.id, params.id))
    },
    { params: idParams },
  )
  .get(
    '/v1/artifacts/:id/download',
    async ({ params, cliUser }) => {
      return cliSuccess(await artifactAccess(cliUser.id, params.id))
    },
    { params: idParams },
  )
