import { parseProjectArtifactId, projectArtifactId } from '@image-playground/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { cliApiRoutes, cliError, cliSuccess } from '../lib/cli-api'
import { resolveCliBearerToken } from '../lib/cli-auth'
import { durableMediaStore } from '../lib/durableMediaStore'
import { accessMedia, completeMedia, MediaError, reserveMedia } from '../lib/projectMedia'

function tokenFromRequest(request: Request): string {
  const value = request.headers.get('authorization') ?? ''
  return value.replace(/^Bearer\s+/i, '').trim()
}

async function currentUser(request: Request) {
  return resolveCliBearerToken(tokenFromRequest(request))
}

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

const mediaParams = t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) })
const artifactParams = t.Object({ id: t.String({ minLength: 1, maxLength: 256 }) })

/** External CLI reference-media and generated-artifact access routes. */
export const cliMediaRoutes = new Elysia({ name: 'cli-media-routes' })
  .use(cliApiRoutes({ authenticate: async (token) => Boolean(await resolveCliBearerToken(token)) }))
  .derive({ as: 'scoped' }, async ({ request }) => ({ cliUser: await currentUser(request) }))
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return cliError('INVALID_REQUEST', 'The request is invalid')
    }
    if (error instanceof MediaError) {
      const apiCode =
        error.status === 404
          ? 'NOT_FOUND'
          : error.status === 409
            ? 'CONFLICT'
            : error.status === 413
              ? 'REQUEST_TOO_LARGE'
              : error.status === 422
                ? 'INVALID_REQUEST'
                : 'INTERNAL_ERROR'
      return cliError(apiCode, 'The media request could not be completed', undefined, error.status)
    }
    set.status = 500
    return cliError('INTERNAL_ERROR', 'The request could not be completed')
  })
  .post(
    '/v1/media',
    async ({ request, body, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
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
    async ({ request, params, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      const value = await completeMedia(cliUser.id, params.id)
      return cliSuccess({ media_id: value.id, ...value })
    },
    { params: mediaParams },
  )
  .get(
    '/v1/media',
    async ({ request, query, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      const limit = query.limit ?? 50
      const rows = await db
        .select()
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
    async ({ request, params, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      return cliSuccess(mapMediaAccess(await accessMedia(cliUser.id, params.id)))
    },
    { params: mediaParams },
  )
  .get(
    '/v1/media/:id/download',
    async ({ request, params, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      const value = mapMediaAccess(await accessMedia(cliUser.id, params.id))
      return cliSuccess({
        media_id: value.media_id,
        download_url: value.original_url,
        content_type: value.content_type,
        bytes: value.bytes,
        expires_at: value.expires_at,
      })
    },
    { params: mediaParams },
  )
  .get(
    '/v1/artifacts/:id',
    async ({ request, params, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      return cliSuccess(await artifactAccess(cliUser.id, params.id))
    },
    { params: artifactParams },
  )
  .get(
    '/v1/artifacts/:id/download',
    async ({ request, params, cliUser }) => {
      if (!cliUser) return cliError('UNAUTHENTICATED', 'Authentication is required')
      const value = await artifactAccess(cliUser.id, params.id)
      return cliSuccess(value)
    },
    { params: artifactParams },
  )
