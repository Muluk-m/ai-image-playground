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

function checkMediaSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new MediaError(422, 'media_size_mismatch')
  if (size > config.operator.quotas['sync:asset-image-bytes'])
    throw new MediaError(413, 'media_too_large')
}

async function readMediaBytes(store: ObjectStore, key: string) {
  const source = await store.open(key)
  checkMediaSize(source.size)
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

/**
 * 这次执行手里已有的原件字节，按「哪个存储里的哪个 key」记。
 * 生成结果刚写进 durable、输入刚从存储读出来做上游请求，入库时就不必再从对象存储读一遍——
 * 生产上对象存储每次往返要几百毫秒，读回一张图（HEAD + GET）约 0.8 s。
 * 只记写入/读取成功的那份；找不到（重启后接着跑的恢复路径）照旧从存储读。
 */
export class KnownMediaBytes {
  private readonly bytes = new Map<string, Uint8Array>()
  private static key(store: 'durable' | 'object', key: string) {
    return `${store}:${key}`
  }
  remember(store: 'durable' | 'object', key: string, bytes: Uint8Array) {
    this.bytes.set(KnownMediaBytes.key(store, key), bytes)
  }
  get(store: 'durable' | 'object', key: string) {
    return this.bytes.get(KnownMediaBytes.key(store, key))
  }
  /** 写成功才记下：写的是哪份字节，入库就用哪份。 */
  recording(store: ObjectStore): ObjectStore {
    return new Proxy(store, {
      get: (target, prop) => {
        if (prop === 'write')
          return async (
            key: string,
            bytes: Uint8Array,
            contentType: string,
            signal?: AbortSignal,
          ) => {
            await target.write(key, bytes, contentType, signal)
            this.remember('durable', key, bytes)
          }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }
  /** 交给 `hydrateInputImages` 的 onObjectRead：只记它按引用从存储读出来的那份原件，与引用一一绑定。 */
  readonly rememberRead = (ref: { object: string; store?: string }, bytes: Uint8Array) => {
    this.remember(ref.store === 'durable' ? 'durable' : 'object', ref.object, bytes)
  }
  /** 入库成功就放掉，不让整个任务期间一直攥着所有原件。 */
  forget(store: 'durable' | 'object', key: string) {
    this.bytes.delete(KnownMediaBytes.key(store, key))
  }
}

/** 同一任务的几张图（结果、输入、遮罩）两张两张并行入库，每张的结果按原顺序交回。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  // 全部收完再报错：不留还在跑的入库在背后继续写。
  for (const result of results) if (result.status === 'rejected') throw result.reason
  return results.map((result) => (result as PromiseFulfilledResult<R>).value)
}

type StoredRef = { object: string; mime: string; store?: string }

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
  known?: KnownMediaBytes,
) {
  const durable = () => (known ? known.recording(durableMediaStore()) : durableMediaStore())
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
      const store = durable()
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
          store: durable(),
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

/**
 * 把这次生成的输入原件挪进长期存储，给出换成 durable 引用后的请求。
 * 落库是执行句柄的事（`preserveInputs`）：这一行只有租约还在的执行者写得动。
 */
export async function durableGenerationInputs(
  request: PersistedSubmitRequest,
): Promise<PersistedSubmitRequest> {
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
    return next
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
  known?: KnownMediaBytes,
) {
  // Worker/reconciliation still spool and checkpoint the originals before completing.
  // Only adoption into a project promotes candidate bytes into capacity-counted media.
  if (request.output_retention === 'candidate') return []
  return withMediaTransfer(async () => {
    const jobs: { role: GenerationMediaLink['role']; position: number; ref: StoredRef }[] = []
    for (const image of extractMeta(provider, payload).images) {
      if (missing.has(image.index)) continue
      const source = resolveImageBytesRef(provider, payload, image.index)
      if (!source || !source.mime.startsWith('image/')) throw new Error('generation_image_missing')
      if (source.kind !== 'object') throw new Error('generation_image_not_archived')
      jobs.push({
        role: 'output',
        position: image.index,
        ref: { object: source.data, mime: source.mime, store: source.store },
      })
    }
    for (const [position, ref] of (request.input_images ?? []).entries())
      jobs.push({ role: 'input', position, ref })
    if (request.mask) jobs.push({ role: 'mask', position: 0, ref: request.mask })
    // 从前一张一张串行：带一张输入图的编辑要多等一整轮确认（生产约 4–5 s）。
    // 两张并行：本实例的确认处理位也是两张起步，不至于把排队挤满。
    return mapWithConcurrency(jobs, 2, async ({ role, position, ref }) => {
      const store = ref.store === 'durable' ? 'durable' : 'object'
      const remembered = known?.get(store, ref.object)
      if (remembered) checkMediaSize(remembered.length)
      const bytes =
        remembered ??
        (await readMediaBytes(
          store === 'durable' ? durableMediaStore() : objectStore(),
          ref.object,
        ))
      const media = await storeMedia(userId, bytes, detectMediaMime(bytes) ?? ref.mime)
      known?.forget(store, ref.object)
      return { role, position, mediaId: media.id } satisfies GenerationMediaLink
    })
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
