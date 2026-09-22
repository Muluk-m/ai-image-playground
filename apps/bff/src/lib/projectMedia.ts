import { createHash } from 'node:crypto'
import { and, eq, gt, or, sql } from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { config } from '../config'
import { db, schema } from '../db/client'
import { PREVIEW_RESIZE } from './agent/modelImage'
import { durableMediaStore } from './durableMediaStore'
import type { BffTransaction } from './private-overlay'

const media = schema.media_objects
const PREVIEW_BUDGET = 512 * 1024
const RESERVATION_MS = 20 * 60 * 1000
type Media = typeof media.$inferSelect
export interface UploadDescriptor {
  sha256: string
  bytes: number
  contentType: string
}
export class MediaError extends Error {
  constructor(
    readonly status: 404 | 409 | 413 | 422 | 503,
    code: string,
  ) {
    super(code)
  }
}

export async function lockMediaOwner(tx: BffTransaction, userId: string) {
  await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('update')
}

/** Call with the user's row locked: old assets and new media share one capacity boundary. */
export async function mediaUsage(tx: BffTransaction, userId: string, now = Date.now()) {
  const [durable] = await tx
    .select({ total: sql<string>`coalesce(sum(${media.reserved_bytes}), 0)` })
    .from(media)
    .where(and(eq(media.user_id, userId), or(eq(media.status, 'ready'), gt(media.expires_at, now))))
  const [legacy] = await tx
    .select({ total: sql<string>`coalesce(sum(${schema.user_asset_objects.bytes}), 0)` })
    .from(schema.user_asset_objects)
    .where(eq(schema.user_asset_objects.user_id, userId))
  return Number(durable?.total ?? 0) + Number(legacy?.total ?? 0)
}

function summary(row: Media) {
  return {
    id: row.id,
    status: row.status,
    bytes: row.bytes,
    contentType: row.content_type,
    width: row.width,
    height: row.height,
  }
}
function uploadResult(row: Media) {
  return row.status === 'ready'
    ? summary(row)
    : {
        ...summary(row),
        uploadUrl: durableMediaStore().sign(row.staging_key, 'PUT', row.content_type),
        expiresAt: row.expires_at,
      }
}

export async function reserveMedia(userId: string, input: UploadDescriptor) {
  if (input.bytes > config.operator.quotas['sync:asset-image-bytes'])
    throw new MediaError(413, 'media_too_large')
  return db.transaction(async (tx) => {
    await lockMediaOwner(tx, userId)
    const [existing] = await tx
      .select()
      .from(media)
      .where(and(eq(media.user_id, userId), eq(media.sha256, input.sha256)))
    if (existing && (existing.bytes !== input.bytes || existing.content_type !== input.contentType))
      throw new MediaError(409, 'media_descriptor_mismatch')
    const now = Date.now()
    if (existing && (existing.status === 'ready' || existing.expires_at > now + 600_000))
      return uploadResult(existing)
    const reserved = input.bytes + PREVIEW_BUDGET
    const used = await mediaUsage(tx, userId, now)
    const previous = existing && existing.expires_at > now ? existing.reserved_bytes : 0
    if (used - previous + reserved > config.operator.quotas['sync:user-media-bytes'])
      throw new MediaError(413, 'media_quota_exceeded')
    const values = {
      reserved_bytes: reserved,
      staging_key: existing?.staging_key ?? `staging/${userId}/${crypto.randomUUID()}`,
      expires_at: now + RESERVATION_MS,
      updated_at: now,
    }
    const [row] = existing
      ? await tx.update(media).set(values).where(eq(media.id, existing.id)).returning()
      : await tx
          .insert(media)
          .values({
            id: crypto.randomUUID(),
            user_id: userId,
            sha256: input.sha256,
            bytes: input.bytes,
            content_type: input.contentType,
            status: 'pending',
            created_at: now,
            ...values,
          })
          .returning()
    return uploadResult(row!)
  })
}

async function ownedMedia(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.user_id, userId)))
  if (!row) throw new MediaError(404, 'media_not_found')
  return row
}

// Bound original buffering and image decoding; callers retry instead of building an unbounded queue.
let processing = false
export async function completeMedia(userId: string, id: string) {
  const row = await ownedMedia(userId, id)
  if (row.status === 'ready') return summary(row)
  if (row.expires_at <= Date.now()) throw new MediaError(409, 'media_upload_expired')
  if (processing) throw new MediaError(503, 'media_processing_busy')
  processing = true
  try {
    const store = durableMediaStore()
    const source = await store.open(row.staging_key)
    if (source.size !== row.bytes) throw new MediaError(422, 'media_size_mismatch')
    const reader = source.stream(0, row.bytes - 1).getReader()
    const bytes = new Uint8Array(row.bytes)
    let offset = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (offset + part.value.length > bytes.length)
          throw new MediaError(422, 'media_size_mismatch')
        bytes.set(part.value, offset)
        offset += part.value.length
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    if (offset !== row.bytes || createHash('sha256').update(bytes).digest('hex') !== row.sha256)
      throw new MediaError(422, 'media_hash_mismatch')
    let metadata: Metadata
    let preview: Buffer
    try {
      const image = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'warning' })
      metadata = await image.metadata()
      if (metadata.pages && metadata.pages > 1) throw new Error('animated_image')
      if (`image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` !== row.content_type)
        throw new Error('content_type_mismatch')
      preview = await image.rotate().resize(PREVIEW_RESIZE).webp({ quality: 75 }).toBuffer()
      if (!metadata.width || !metadata.height || preview.length > PREVIEW_BUDGET)
        throw new Error('invalid_preview')
    } catch {
      throw new MediaError(422, 'media_invalid_image')
    }
    // Never publish the client-writable key. This verified buffer is written to a fresh server-only key.
    const prefix = `objects/${userId}/${id}/${crypto.randomUUID()}`
    const objectKey = `${prefix}/original`
    const previewKey = `${prefix}/preview.webp`
    await store.write(objectKey, bytes, row.content_type)
    await store.write(previewKey, preview, 'image/webp')
    if (
      (await store.open(objectKey)).size !== bytes.length ||
      (await store.open(previewKey)).size !== preview.length
    )
      throw new MediaError(503, 'media_not_readable')
    return await db.transaction(async (tx) => {
      await lockMediaOwner(tx, userId)
      const [current] = await tx
        .select()
        .from(media)
        .where(and(eq(media.id, id), eq(media.user_id, userId)))
      if (!current) throw new MediaError(404, 'media_not_found')
      if (current.status === 'ready') return summary(current)
      if (current.expires_at <= Date.now() || current.staging_key !== row.staging_key)
        throw new MediaError(409, 'media_upload_expired')
      const [ready] = await tx
        .update(media)
        .set({
          status: 'ready',
          object_key: objectKey,
          preview_key: previewKey,
          preview_bytes: preview.length,
          reserved_bytes: bytes.length + preview.length,
          width: metadata.width!,
          height: metadata.height!,
          updated_at: Date.now(),
        })
        .where(eq(media.id, id))
        .returning()
      return summary(ready!)
    })
  } catch (error) {
    if (error instanceof MediaError) throw error
    throw new MediaError(503, 'media_storage_unavailable')
  } finally {
    processing = false
  }
}

export async function accessMedia(userId: string, id: string) {
  const row = await ownedMedia(userId, id)
  if (row.status !== 'ready' || !row.object_key || !row.preview_key)
    throw new MediaError(409, 'media_not_ready')
  const store = durableMediaStore()
  return {
    ...summary(row),
    originalUrl: store.sign(row.object_key, 'GET'),
    previewUrl: store.sign(row.preview_key, 'GET'),
    expiresAt: Date.now() + 600_000,
  }
}

export async function storeMedia(userId: string, bytes: Uint8Array, contentType: string) {
  const reserved = await reserveMedia(userId, {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType,
  })
  if (reserved.status === 'ready') return reserved
  const row = await ownedMedia(userId, reserved.id)
  await durableMediaStore().write(row.staging_key, bytes, contentType)
  return completeMedia(userId, row.id)
}
