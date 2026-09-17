import { setTimeout as delay } from 'node:timers/promises'
import type { PersistedSubmitRequest, QueueProvider } from '@image-playground/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { durableMediaStore } from './durableMediaStore'
import { extractMeta, resolveImageBytesRef } from './extractImages'
import {
  archiveOutputImages,
  detectMediaMime,
  MaskedOutputArchiveError,
  ObjectStorageError,
  type OutputTransform,
  SourceImageFetchError,
} from './imageArchive'
import { log } from './logger'
import { type ObjectStore, objectStore } from './objectStore'
import type { BffTransaction } from './private-overlay'
import { lockMediaOwner, MediaError, storeMedia } from './projectMedia'
import { UpstreamResultUnknownError } from './upstream'

let transfers = 0
const waiting: (() => void)[] = []
async function withMediaTransfer<T>(work: () => Promise<T>): Promise<T> {
  if (transfers >= 2) {
    if (waiting.length >= 20) throw new MediaError(503, 'media_processing_busy')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else transfers++
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else transfers--
  }
}

async function readMediaBytes(store: ObjectStore, key: string) {
  const source = await store.open(key)
  if (!Number.isSafeInteger(source.size) || source.size <= 0)
    throw new MediaError(422, 'media_size_mismatch')
  if (source.size > config.operator.quotas['sync:asset-image-bytes'])
    throw new MediaError(413, 'media_too_large')
  const bytes = new Uint8Array(source.size)
  const reader = source.stream(0, source.size - 1).getReader()
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
  if (offset !== bytes.length) throw new MediaError(422, 'media_size_mismatch')
  return bytes
}

export interface GenerationMediaLink {
  role: 'input' | 'mask' | 'output'
  position: number
  mediaId: string
}

/** Record deterministic destinations before writing bytes; PostgreSQL never stores inline originals. */
export function generationSourceCheckpoint(id: string, provider: QueueProvider, payload: unknown) {
  const meta = extractMeta(provider, payload)
  const refs = meta.images.map((image) => {
    const ref = resolveImageBytesRef(provider, payload, image.index)
    if (!ref) throw new Error('generation_image_missing')
    return { ...ref, index: image.index }
  })
  if (!refs.length) return null
  if (provider === 'openai-compat')
    return {
      ...meta.actual_params,
      archive_store: 'durable',
      data: refs.map((ref) => ({
        ...(ref.kind === 'url' ? { url: ref.data } : { object: `${id}/out/${ref.index}` }),
        mime: ref.mime,
      })),
    }
  return {
    archive_store: 'durable',
    candidates: [
      {
        content: {
          parts: refs.map((ref) => ({
            inlineData: { object: `${id}/out/${ref.index}`, mimeType: ref.mime },
          })),
        },
      },
    ],
  }
}

/** A successful inline response remains in its worker slot until safely spooled or interrupted. */
export async function spoolGenerationOutputs(
  id: string,
  provider: QueueProvider,
  payload: unknown,
  transform: OutputTransform | undefined,
  signal: AbortSignal,
) {
  if (
    payload &&
    typeof payload === 'object' &&
    'archive_store' in payload &&
    payload.archive_store === 'durable'
  ) {
    payload = await withMediaTransfer(async () => {
      const next = structuredClone(payload) as {
        data?: Record<string, unknown>[]
        candidates?: { content?: { parts?: { inlineData?: Record<string, unknown> }[] } }[]
      }
      const entries =
        provider === 'openai-compat'
          ? (next.data ?? [])
          : (next.candidates ?? []).flatMap((candidate) =>
              (candidate.content?.parts ?? []).flatMap((part) =>
                part.inlineData ? [part.inlineData] : [],
              ),
            )
      const store = durableMediaStore()
      const keys = new Set(await store.listPrefix(`${id}/`))
      for (const [index, item] of entries.entries()) {
        const key = `${id}/out/${index}`
        const candidate = `${id}/candidate/${index}`
        if (!keys.has(key) && transform && keys.has(candidate)) {
          let output: Awaited<ReturnType<OutputTransform>>
          try {
            output = await transform(await readMediaBytes(store, candidate))
          } catch (cause) {
            throw new MaskedOutputArchiveError(
              cause instanceof Error ? cause.message : '局部编辑结果无法应用',
              [{ object: candidate, mime: 'image/png', store: 'durable' }],
              { cause },
            )
          }
          await store.write(key, output.bytes, output.mime)
          keys.add(key)
          item[provider === 'openai-compat' ? 'mime' : 'mimeType'] = output.mime
          item.masked_edit = {
            ...output.inspection,
            candidate: { object: candidate, mime: 'image/png', store: 'durable' },
          }
          item.size = `${output.inspection.width}x${output.inspection.height}`
        }
        if (keys.has(key)) {
          item.object = key
          delete item.url
          delete item[provider === 'openai-compat' ? 'b64_json' : 'data']
        }
      }
      return next
    })
  }
  const deadline = performance.now() + 15 * 60_000
  let attempt = 0
  while (true) {
    signal.throwIfAborted()
    try {
      const archived = await withMediaTransfer(() =>
        archiveOutputImages(id, provider, structuredClone(payload), transform, {
          store: durableMediaStore(),
          retainOnFailure: true,
          maxBytes: config.operator.quotas['sync:asset-image-bytes'],
          signal,
        }),
      )
      return { ...archived, archive_store: 'durable' }
    } catch (error) {
      if (
        !(error instanceof ObjectStorageError) ||
        error instanceof SourceImageFetchError ||
        error instanceof MaskedOutputArchiveError
      )
        throw error
      if (performance.now() >= deadline)
        throw new UpstreamResultUnknownError(
          '图片已生成，但存储持续不可用，无法确认原件已保存；不会自动重新生成',
          { cause: error },
        )
      log.warn(
        { event: 'task.spool_retry', taskId: id, attempt: ++attempt },
        'retaining successful response while object storage recovers',
      )
      await delay(Math.min(30_000, 250 * 2 ** Math.min(attempt - 1, 7)), undefined, { signal })
    }
  }
}

export async function preserveGenerationInputs(id: string, request: PersistedSubmitRequest) {
  return withMediaTransfer(async () => {
    const preserve = async (ref: NonNullable<PersistedSubmitRequest['mask']>) => {
      if (ref.store === 'durable') return ref
      await durableMediaStore().write(
        ref.object,
        await readMediaBytes(objectStore(), ref.object),
        ref.mime,
      )
      return { ...ref, store: 'durable' as const }
    }
    const next = { ...request }
    if (request.input_images) {
      next.input_images = []
      for (const ref of request.input_images) next.input_images.push(await preserve(ref))
    }
    if (request.mask) next.mask = await preserve(request.mask)
    const updated = await db
      .update(schema.tasks)
      .set({ request_payload: next })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'in_progress')))
      .returning({ id: schema.tasks.id })
    return updated.length ? next : null
  })
}

/** A successful listing distinguishes missing bytes from a transient storage outage. */
export async function missingGenerationOutputs(
  id: string,
  provider: QueueProvider,
  payload: unknown,
) {
  const keys = new Set(await durableMediaStore().listPrefix(`${id}/out/`))
  return new Set(
    extractMeta(provider, payload)
      .images.filter((image) => {
        const ref = resolveImageBytesRef(provider, payload, image.index)
        return ref?.kind === 'object' && ref.store === 'durable' && !keys.has(ref.data)
      })
      .map((image) => image.index),
  )
}

export async function archiveGenerationOutputs(
  userId: string,
  provider: QueueProvider,
  payload: unknown,
  request: PersistedSubmitRequest,
  missing: ReadonlySet<number> = new Set(),
) {
  return withMediaTransfer(async () => {
    const links: GenerationMediaLink[] = []
    for (const image of extractMeta(provider, payload).images) {
      if (missing.has(image.index)) continue
      const source = resolveImageBytesRef(provider, payload, image.index)
      if (!source || !source.mime.startsWith('image/')) throw new Error('generation_image_missing')
      if (source.kind !== 'object') throw new Error('generation_image_not_archived')
      const bytes = await readMediaBytes(
        source.store === 'durable' ? durableMediaStore() : objectStore(),
        source.data,
      )
      const media = await storeMedia(userId, bytes, detectMediaMime(bytes) ?? source.mime)
      links.push({ role: 'output', position: image.index, mediaId: media.id })
    }
    for (const [position, ref] of (request.input_images ?? []).entries()) {
      const media = await storeMedia(
        userId,
        await readMediaBytes(
          ref.store === 'durable' ? durableMediaStore() : objectStore(),
          ref.object,
        ),
        ref.mime,
      )
      links.push({ role: 'input', position, mediaId: media.id })
    }
    if (request.mask) {
      const media = await storeMedia(
        userId,
        await readMediaBytes(
          request.mask.store === 'durable' ? durableMediaStore() : objectStore(),
          request.mask.object,
        ),
        request.mask.mime,
      )
      links.push({ role: 'mask', position: 0, mediaId: media.id })
    }
    return links
  })
}

export async function publishGenerationImages(
  tx: BffTransaction,
  userId: string,
  id: string,
  links: GenerationMediaLink[],
) {
  if (!links.length) return
  await lockMediaOwner(tx, userId)
  const ids = [...new Set(links.map((link) => link.mediaId))]
  const owned = await tx
    .select({ id: schema.media_objects.id })
    .from(schema.media_objects)
    .where(
      and(
        eq(schema.media_objects.user_id, userId),
        eq(schema.media_objects.status, 'ready'),
        inArray(schema.media_objects.id, ids),
      ),
    )
  if (owned.length !== ids.length) throw new Error('generation_media_not_ready')
  await tx
    .insert(schema.generation_images)
    .values(
      links.map((link) => ({
        generation_id: id,
        role: link.role,
        position: link.position,
        media_id: link.mediaId,
      })),
    )
    .onConflictDoNothing()
  await tx
    .insert(schema.media_references)
    .values(
      ids.map((mediaId) => ({
        user_id: userId,
        media_id: mediaId,
        owner_kind: 'generation' as const,
        owner_id: id,
        created_at: Date.now(),
      })),
    )
    .onConflictDoNothing()
}
