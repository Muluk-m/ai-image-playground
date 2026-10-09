import { createHash } from 'node:crypto'
import {
  and,
  eq,
  exists,
  gt,
  isNotNull,
  lte,
  not,
  notExists,
  notInArray,
  or,
  sql,
} from 'drizzle-orm'
import sharp, { type Metadata } from 'sharp'
import { config } from '../config'
import { db, schema } from '../db/client'
import { PREVIEW_RESIZE } from './agent/modelImage'
import { isCapabilityEnabled } from './capabilities'
import { durableMediaStore } from './durableMediaStore'
import { log } from './logger'
import { assertMediaImageProcessingBudget, MEDIA_UPLOAD_MAX_PIXELS } from './media-image-limits'
import { withMediaObjectLock } from './mediaObjectLock'
import { attachmentLimits } from './operator-config'
import type { BffTransaction } from './private-overlay'

const media = schema.media_objects
const PREVIEW_BUDGET = 512 * 1024
const RESERVATION_MS = 20 * 60 * 1000
type Media = typeof media.$inferSelect
export interface UploadDescriptor {
  sha256: string
  purpose?: 'conversation-attachment'
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
  // Serialize owner mutations without blocking foreign-key references from durable events.
  await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('no key update')
}

/** Call with the user's row locked: old assets and new media share one capacity boundary. */
export async function mediaUsage(tx: BffTransaction, userId: string, now = Date.now()) {
  const [durable] = await tx
    .select({ total: sql<string>`coalesce(sum(${media.reserved_bytes}), 0)` })
    .from(media)
    .where(
      and(
        eq(media.user_id, userId),
        or(
          eq(media.attachment_managed, true),
          eq(media.status, 'ready'),
          gt(media.expires_at, now),
        ),
      ),
    )
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
    ...(row.attachment_lease_until ? { leaseExpiresAt: row.attachment_lease_until } : {}),
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
  const attachment = input.purpose === 'conversation-attachment'
  if (attachment && !isCapabilityEnabled('agent:attachments'))
    throw new MediaError(409, 'attachment_uploads_unavailable')
  const byteLimit = attachment
    ? (attachmentLimits(config.operator)?.imageBytes ??
      config.operator.quotas['sync:asset-image-bytes'])
    : config.operator.quotas['sync:asset-image-bytes']
  if (input.bytes > byteLimit) throw new MediaError(413, 'media_too_large')
  return db.transaction(async (tx) => {
    await lockMediaOwner(tx, userId)
    let [existing] = await tx
      .select()
      .from(media)
      .where(and(eq(media.user_id, userId), eq(media.sha256, input.sha256)))
    if (existing?.status === 'deleting') throw new MediaError(409, 'media_deleting')
    const leaseUntil = attachment
      ? Date.now() + config.operator.quotas['sync:attachment-lease-seconds'] * 1000
      : undefined
    if (existing && leaseUntil) {
      ;[existing] = await tx
        .update(media)
        .set({ attachment_lease_until: leaseUntil })
        .where(eq(media.id, existing.id))
        .returning()
    }
    // 已发布的那份不能被改写：它的字节已经过校验，描述符必须与当初一致。还没确认的那条只是
    // 一次预留，客户端改正申报（例如从前把 WebP 报成 png）要能接着用同一个身份重传。
    if (
      existing?.status === 'ready' &&
      (existing.bytes !== input.bytes || existing.content_type !== input.contentType)
    )
      throw new MediaError(409, 'media_descriptor_mismatch')
    const now = Date.now()
    // 还没到期的那条预留照旧原样交回；申报改过（类型纠正）的必须落到行上，否则签出的
    // PUT 地址与确认时的校验都还按旧类型走。
    const described = existing?.bytes === input.bytes && existing.content_type === input.contentType
    if (
      existing &&
      (existing.status === 'ready' || (described && existing.expires_at > now + 600_000))
    )
      return uploadResult(existing)
    const reserved = input.bytes + PREVIEW_BUDGET
    const used = await mediaUsage(tx, userId, now)
    const previous =
      existing && (existing.attachment_managed || existing.expires_at > now)
        ? existing.reserved_bytes
        : 0
    if (used - previous + reserved > config.operator.quotas['sync:user-media-bytes'])
      throw new MediaError(413, 'media_quota_exceeded')
    const values = {
      bytes: input.bytes,
      content_type: input.contentType,
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
            status: 'pending',
            attachment_managed: attachment,
            attachment_lease_until: leaseUntil ?? null,
            created_at: now,
            ...values,
          })
          .returning()
    return uploadResult(row!)
  })
}

async function ownedMedia(userId: string, id: string, executor: Pick<typeof db, 'select'> = db) {
  const [row] = await executor
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.user_id, userId)))
  if (!row) throw new MediaError(404, 'media_not_found')
  return row
}

// Overlap storage I/O for two originals, while decoding at most one image at a time.
let processing = 0
const processingQueue: { resume: () => void; reject: () => void }[] = []
async function withMediaProcessing<T>(work: () => Promise<T>): Promise<T> {
  if (processing < 2) processing++
  else {
    if (processingQueue.length >= 8) throw new MediaError(503, 'media_processing_busy')
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resume: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: () => {
          const index = processingQueue.indexOf(entry)
          if (index >= 0) processingQueue.splice(index, 1)
          reject(new MediaError(503, 'media_processing_busy'))
        },
      }
      const timer = setTimeout(entry.reject, 10_000)
      processingQueue.push(entry)
    })
  }
  try {
    return await work()
  } finally {
    const next = processingQueue.shift()
    if (next) next.resume()
    else processing--
  }
}
let decoding: Promise<void> = Promise.resolve()
async function withMediaDecode<T>(work: () => Promise<T>): Promise<T> {
  const previous = decoding
  let release!: () => void
  decoding = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await work()
  } finally {
    release()
  }
}
export async function completeMedia(userId: string, id: string) {
  // A lost confirmation response must not make immutable, verified media wait behind new I/O.
  const existing = await ownedMedia(userId, id)
  if (existing.status === 'ready') return summary(existing)
  const result = await withMediaProcessing(() =>
    withMediaObjectLock(id, async (database) => {
      const row = await ownedMedia(userId, id, database)
      if (row.status === 'ready') return summary(row)
      if (row.status === 'deleting') throw new MediaError(409, 'media_deleting')
      if (row.expires_at <= Date.now()) throw new MediaError(409, 'media_upload_expired')
      const limits = row.attachment_managed ? attachmentLimits(config.operator) : undefined
      if (limits && row.bytes > limits.imageBytes) throw new MediaError(413, 'media_too_large')
      let candidatePrefix: string | undefined
      let published = false
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
        let observed: Metadata | undefined
        try {
          const decoded = await withMediaDecode(async () => {
            const image = sharp(bytes, {
              limitInputPixels: limits?.imagePixels ?? MEDIA_UPLOAD_MAX_PIXELS,
              failOn: 'warning',
            })
            const metadata = await image.metadata()
            observed = metadata
            if (metadata.pages && metadata.pages > 1) throw new Error('animated_image')
            if (
              `image/${metadata.format === 'jpeg' ? 'jpeg' : metadata.format}` !== row.content_type
            )
              throw new Error('content_type_mismatch')
            assertMediaImageProcessingBudget(metadata)
            const preview = await image
              .timeout({ seconds: 15 })
              .rotate()
              .resize(PREVIEW_RESIZE)
              .webp({ quality: 75 })
              .toBuffer()
            if (!metadata.width || !metadata.height || preview.length > PREVIEW_BUDGET)
              throw new Error('invalid_preview')
            return { metadata, preview }
          })
          metadata = decoded.metadata
          preview = decoded.preview
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          let reason = observed ? 'preview_failed' : 'decode_failed'
          if (message === 'processing_budget' || /timeout/i.test(message))
            reason = 'processing_budget'
          else if (/pixel limit/i.test(message)) reason = 'pixel_limit'
          else if (['animated_image', 'content_type_mismatch', 'invalid_preview'].includes(message))
            reason = message
          let errorCode = 'media_invalid_image'
          if (reason === 'pixel_limit') errorCode = 'media_image_pixels_exceeded'
          else if (reason === 'processing_budget') errorCode = 'media_image_processing_limit'
          log.warn(
            {
              event: 'media.validation_failed',
              userId,
              mediaId: id,
              errorCode,
              reason,
              bytes: row.bytes,
              declaredContentType: row.content_type,
              detectedFormat: observed?.format,
              width: observed?.width,
              height: observed?.height,
              pixelLimit: limits?.imagePixels ?? MEDIA_UPLOAD_MAX_PIXELS,
              err: error,
            },
            'uploaded image validation failed',
          )
          throw new MediaError(422, errorCode)
        }
        // Never publish the client-writable key. This verified buffer is written to a fresh server-only key.
        const prefix = `objects/${userId}/${id}/${crypto.randomUUID()}`
        candidatePrefix = prefix
        const objectKey = `${prefix}/original`
        const previewKey = `${prefix}/preview.webp`
        const written = await Promise.allSettled([
          store.write(objectKey, bytes, row.content_type),
          store.write(previewKey, preview, 'image/webp'),
        ])
        for (const result of written) if (result.status === 'rejected') throw result.reason
        const [original, thumbnail] = await Promise.all([
          store.open(objectKey),
          store.open(previewKey),
        ])
        if (original.size !== bytes.length || thumbnail.size !== preview.length)
          throw new MediaError(503, 'media_not_readable')
        return await database.transaction(async (tx) => {
          await lockMediaOwner(tx, userId)
          const [current] = await tx
            .select()
            .from(media)
            .where(and(eq(media.id, id), eq(media.user_id, userId)))
          if (!current) throw new MediaError(404, 'media_not_found')
          if (current.status === 'ready') return summary(current)
          if (current.status === 'deleting') throw new MediaError(409, 'media_deleting')
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
          published = true
          return summary(ready!)
        })
      } catch (error) {
        if (error instanceof MediaError) throw error
        throw new MediaError(503, 'media_storage_unavailable')
      } finally {
        if (candidatePrefix && !published) {
          try {
            await durableMediaStore().deletePrefix(`${candidatePrefix}/`)
          } catch {
            /* Still charged; the managed media sweep retries the whole prefix. */
          }
        }
      }
    }),
  )
  if (!result) throw new MediaError(503, 'media_processing_busy')
  return result
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

/** Only explicitly managed attachments are eligible; legacy media have incomplete references. */
export async function purgeExpiredAttachmentMedia(now = Date.now()): Promise<number> {
  const expired = and(
    eq(media.attachment_managed, true),
    or(
      eq(media.status, 'deleting'),
      and(
        isNotNull(media.attachment_lease_until),
        lte(media.attachment_lease_until, now),
        // A ready image may still have a valid, previously signed staging PUT URL.
        lte(media.expires_at, now),
      ),
    ),
  )
  const protection = or(
    exists(
      db
        .select({ id: schema.media_references.media_id })
        .from(schema.media_references)
        .where(eq(schema.media_references.media_id, media.id)),
    ),
    exists(
      db
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(
          and(
            eq(schema.tasks.user_id, media.user_id),
            notInArray(schema.tasks.status, ['completed', 'failed', 'cancelled']),
          ),
        ),
    ),
    exists(
      db
        .select({ id: schema.agent_executions.turn_id })
        .from(schema.agent_executions)
        .innerJoin(
          schema.agent_conversations,
          eq(schema.agent_conversations.id, schema.agent_executions.conversation_id),
        )
        .where(
          and(
            eq(schema.agent_conversations.user_id, media.user_id),
            eq(schema.agent_executions.state, 'running'),
          ),
        ),
    ),
  )!
  const candidates = await db
    .select({ id: media.id, userId: media.user_id })
    .from(media)
    .where(and(expired, or(eq(media.status, 'deleting'), not(protection))))
    .limit(100)
  let removed = 0
  for (const candidate of candidates) {
    const count = await withMediaObjectLock(candidate.id, async (database) => {
      const claimed = await database.transaction(async (tx) => {
        await lockMediaOwner(tx, candidate.userId)
        const [row] = await tx
          .select()
          .from(media)
          .where(and(eq(media.id, candidate.id), expired))
        if (!row) return null
        if (row.status === 'deleting') return row
        // Deleted conversations can still have unsettled work. Until task-owned media references
        // cover every producer, defer this owner's reclamation while any task is nonterminal.
        const protectedMedia = await tx
          .select({ id: media.id })
          .from(media)
          .where(and(eq(media.id, row.id), protection))
        if (protectedMedia.length) return null
        const [deleting] = await tx
          .update(media)
          .set({ status: 'deleting', updated_at: now })
          .where(eq(media.id, row.id))
          .returning()
        return deleting ?? null
      })
      if (!claimed) return 0
      try {
        await durableMediaStore().deletePrefix(`objects/${claimed.user_id}/${claimed.id}/`)
        await durableMediaStore().deletePrefix(claimed.staging_key)
        return await database.transaction(async (tx) => {
          await lockMediaOwner(tx, claimed.user_id)
          const deleted = await tx
            .delete(media)
            .where(
              and(
                eq(media.id, claimed.id),
                eq(media.status, 'deleting'),
                notExists(
                  tx
                    .select({ id: schema.media_references.media_id })
                    .from(schema.media_references)
                    .where(eq(schema.media_references.media_id, claimed.id)),
                ),
              ),
            )
            .returning({ id: media.id })
          return deleted.length
        })
      } catch (error) {
        log.warn(
          { event: 'media.attachment_cleanup_failed', mediaId: claimed.id, err: error },
          'attachment deletion will retry; capacity remains reserved',
        )
        return 0
      }
    })
    removed += count ?? 0
  }
  return removed
}
