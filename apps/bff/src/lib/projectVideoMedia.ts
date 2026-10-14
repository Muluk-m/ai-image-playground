import { createHash } from 'node:crypto'
import { and, eq, gt } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'
import { resolveImageBytesRef } from './extractImages'
import { detectMediaMime } from './imageArchive'
import { withMediaObjectLock } from './mediaObjectLock'
import { type ObjectRangeReader, objectStore } from './objectStore'
import {
  lockMediaOwner,
  MediaError,
  mediaSummary,
  reserveGeneratedVideoMedia,
} from './projectMedia'
import { asQueueProvider } from './queueProvider'
import { rangeStreamResponse } from './rangeResponse'

/** Hash and validate while streaming; neither original nor destination is buffered in the BFF. */
function checkedVideo(
  source: ObjectRangeReader,
  mime: string,
  signal: AbortSignal,
  expected?: string,
) {
  const hash = createHash('sha256')
  const header = new Uint8Array(32)
  let headerSize = 0
  let size = 0
  let digest = ''
  const stream = source.stream(0, source.size - 1).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length
        if (size > source.size) throw new MediaError(422, 'media_size_mismatch')
        const head = chunk.subarray(0, header.length - headerSize)
        header.set(head, headerSize)
        headerSize += head.length
        hash.update(chunk)
        controller.enqueue(chunk)
      },
      flush() {
        if (size !== source.size) throw new MediaError(422, 'media_size_mismatch')
        const actual = detectMediaMime(header.subarray(0, headerSize))
        if (actual !== mime) throw new MediaError(422, 'media_type_mismatch')
        digest = hash.digest('hex')
        if (expected && expected !== digest) throw new MediaError(422, 'media_hash_mismatch')
      },
    }),
    { signal },
  )
  return { stream, digest: () => digest }
}

const promotions = new Map<string, Promise<Awaited<ReturnType<typeof promote>>>>()
export async function promoteQueueVideo(userId: string, taskId: string, outputIndex: number) {
  const key = JSON.stringify([userId, taskId, outputIndex])
  const pending = promotions.get(key)
  if (pending) return pending
  if (promotions.size >= 4) throw new MediaError(503, 'media_processing_busy')
  const work = promote(userId, taskId, outputIndex).finally(() => promotions.delete(key))
  promotions.set(key, work)
  return work
}

async function promote(userId: string, taskId: string, outputIndex: number) {
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.user_id, userId)))
  if (!task) throw new MediaError(404, 'task_not_found')
  if (task.status !== 'completed') throw new MediaError(409, 'task_not_ready')
  const provider = asQueueProvider(task.provider)
  const ref = provider && resolveImageBytesRef(provider, task.result_payload, outputIndex)
  if (!ref || ref.kind !== 'object' || ref.mime !== 'video/mp4')
    throw new MediaError(404, 'video_output_not_found')
  const store = ref.store === 'durable' ? durableMediaStore() : objectStore()
  const signal = AbortSignal.timeout(120_000)
  let destination: string | undefined
  let published = false
  try {
    const source = await store.open(ref.data, signal)
    if (!Number.isSafeInteger(source.size) || source.size <= 0)
      throw new MediaError(422, 'media_size_mismatch')
    if (source.size > config.operator.quotas['sync:asset-video-bytes'])
      throw new MediaError(413, 'media_too_large')
    const inspection = checkedVideo(source, ref.mime, signal)
    const reader = inspection.stream.getReader()
    try {
      while (!(await reader.read()).done) {
        /* bounded streaming hash */
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const reserved = await reserveGeneratedVideoMedia(userId, {
      sha256: inspection.digest(),
      bytes: source.size,
      contentType: ref.mime,
    })
    if (reserved.status === 'ready') return reserved
    const ready = await withMediaObjectLock(reserved.id, async (database) => {
      const [row] = await database
        .select()
        .from(schema.media_objects)
        .where(
          and(eq(schema.media_objects.id, reserved.id), eq(schema.media_objects.user_id, userId)),
        )
      if (!row) throw new MediaError(404, 'media_not_found')
      if (row.status === 'ready') return mediaSummary(row)
      if (row.status !== 'pending') throw new MediaError(409, 'media_deleting')
      destination = `objects/${userId}/${row.id}/${crypto.randomUUID()}`
      const key = `${destination}/original`
      const fresh = await store.open(ref.data, signal)
      if (fresh.size !== source.size) throw new MediaError(422, 'media_size_mismatch')
      await durableMediaStore().writeStream(
        key,
        checkedVideo(fresh, ref.mime, signal, inspection.digest()).stream,
        ref.mime,
        source.size,
        signal,
      )
      if ((await durableMediaStore().open(key, signal)).size !== source.size)
        throw new MediaError(422, 'media_size_mismatch')
      return database.transaction(async (tx) => {
        await lockMediaOwner(tx, userId)
        const [saved] = await tx
          .update(schema.media_objects)
          .set({
            status: 'ready',
            object_key: key,
            preview_key: key,
            preview_bytes: 0,
            reserved_bytes: source.size,
            updated_at: Date.now(),
          })
          .where(
            and(
              eq(schema.media_objects.id, row.id),
              eq(schema.media_objects.status, 'pending'),
              eq(schema.media_objects.bytes, source.size),
              eq(schema.media_objects.content_type, ref.mime),
              gt(schema.media_objects.expires_at, Date.now()),
            ),
          )
          .returning()
        if (!saved) throw new MediaError(409, 'media_not_ready')
        return mediaSummary(saved)
      })
    })
    if (!ready) throw new MediaError(503, 'media_processing_busy')
    published = true
    return ready
  } catch (error) {
    if (error instanceof MediaError) throw error
    throw new MediaError(503, 'media_storage_unavailable')
  } finally {
    if (destination && !published) {
      try {
        await durableMediaStore().deletePrefix(`${destination}/`)
      } catch {
        /* Pending reservation remains charged until retry/cleanup. */
      }
    }
  }
}

export async function serveMediaContent(userId: string, mediaId: string, request: Request) {
  const [media] = await db
    .select()
    .from(schema.media_objects)
    .where(and(eq(schema.media_objects.id, mediaId), eq(schema.media_objects.user_id, userId)))
  if (!media) throw new MediaError(404, 'media_not_found')
  if (media.status !== 'ready' || !media.object_key) throw new MediaError(409, 'media_not_ready')
  try {
    return rangeStreamResponse(
      await durableMediaStore().open(media.object_key),
      media.content_type,
      'private, no-store',
      request.headers.get('range'),
    )
  } catch {
    throw new MediaError(503, 'media_storage_unavailable')
  }
}
