import type {
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  StoredImageRef,
  SubmitRequest,
  VideoRequest,
} from '@image-playground/shared'
import { MaskedOutputError } from './agent/masked-output'
import { durableMediaStore } from './durableMediaStore'
import { type ObjectStore, objectStore } from './objectStore'
import { isAbortError } from './queueProvider'

export type OutputTransform = (bytes: Uint8Array) => Promise<{
  bytes: Uint8Array
  mime: string
  inspection: Record<string, number>
}>

export type HydratedVideoRequest = VideoRequest & { source_video?: string }
export type HydratedSubmitRequest = Omit<SubmitRequest, 'video'> & {
  video?: HydratedVideoRequest
}

const STORAGE_WRITE_ATTEMPTS = 3
const STORAGE_RETRY_DELAYS_MS = [50, 150] as const

export class ObjectStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ObjectStorageError'
  }
}

/**
 * 旧匿名任务沿用模型重试策略；云端任务已有归档凭据，只重试下载原结果。
 */
export class SourceImageFetchError extends ObjectStorageError {
  readonly retryable = true

  constructor(detail: string, options?: ErrorOptions) {
    super(`Object storage output archive failed: ${detail}`, options)
    this.name = 'SourceImageFetchError'
  }
}

export function isStoredImageRef(value: unknown): value is StoredImageRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<StoredImageRef>
  return typeof ref.object === 'string' && ref.object.length > 0 && typeof ref.mime === 'string'
}

export async function archiveInputImages(
  taskId: string,
  request: SubmitRequest,
): Promise<PersistedSubmitRequest> {
  const archived = { ...request } as PersistedSubmitRequest
  let index = 0

  if (request.input_images?.length) {
    const refs: StoredImageRef[] = []
    for (const input of request.input_images) {
      const decoded = decodeDataUrl(input)
      const ref = { object: `${taskId}/in/${index}`, mime: decoded.mime }
      await writeWithRetry(ref.object, decoded.bytes, ref.mime)
      refs.push(ref)
      index++
    }
    archived.input_images = refs
  }

  if (request.mask) {
    const decoded = decodeDataUrl(request.mask)
    const ref = { object: `${taskId}/in/${index}`, mime: decoded.mime }
    await writeWithRetry(ref.object, decoded.bytes, ref.mime)
    archived.mask = ref
  }

  return archived
}

export async function hydrateInputImages(
  request: SubmitRequest | PersistedSubmitRequest,
): Promise<HydratedSubmitRequest> {
  const {
    preserve_outside_mask: _boundary,
    masked_original_size: _originalSize,
    ...upstreamRequest
  } = request as PersistedSubmitRequest
  const hydrated = { ...upstreamRequest } as HydratedSubmitRequest
  if (request.input_images) {
    const inputs: string[] = []
    for (const input of request.input_images) {
      inputs.push(isStoredImageRef(input) ? await hydrateObjectRef(input) : input)
    }
    hydrated.input_images = inputs
  }
  if (request.mask) {
    hydrated.mask = isStoredImageRef(request.mask)
      ? await hydrateObjectRef(request.mask)
      : request.mask
  }
  const video = request.video as PersistedVideoRequest | undefined
  const source = video?.source_video
  if (video && source) {
    hydrated.video = { ...video, source_video: await hydrateObjectRef(source) }
  }
  return hydrated
}

interface ArchiveOptions {
  store?: ObjectStore
  retainOnFailure?: boolean
  maxBytes?: number
  signal?: AbortSignal
}
type ArchiveContext = ArchiveOptions & { store: ObjectStore }

export async function archiveOutputImages(
  taskId: string,
  provider: QueueProvider,
  payload: unknown,
  transform?: OutputTransform,
  options: ArchiveOptions = {},
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') {
    throw new ObjectStorageError('Object storage archive failed: upstream payload is not an object')
  }

  const context = { ...options, store: options.store ?? objectStore() }
  try {
    if (provider === 'openai-compat') await archiveOpenAIOutput(taskId, payload, transform, context)
    else await archiveGeminiOutput(taskId, payload, transform, context)
    return payload as Record<string, unknown>
  } catch (error) {
    if (!options.retainOnFailure) {
      try {
        await context.store.deletePrefix(`${taskId}/out/`)
      } catch {
        // Legacy unreferenced objects remain covered by lifecycle cleanup.
      }
    }
    if (isAbortError(error)) throw error
    // 必须原样重抛：包一层 ObjectStorageError 会丢掉 SourceImageFetchError 的 retryable。
    if (error instanceof ObjectStorageError || error instanceof MaskedOutputError) throw error
    throw new ObjectStorageError('Object storage output archive failed', { cause: error })
  }
}

export class MaskedOutputArchiveError extends ObjectStorageError {
  constructor(
    message: string,
    readonly candidates: readonly StoredImageRef[],
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

async function archiveOpenAIOutput(
  taskId: string,
  payload: object,
  transform: OutputTransform | undefined,
  context: ArchiveContext,
): Promise<void> {
  const response = payload as {
    data?: Array<Record<string, unknown>>
    output_format?: string
    size?: string
  }
  await archiveOutputs(
    taskId,
    (response.data ?? []).map((item) => ({ item, dataKey: 'b64_json', mimeKey: 'mime' })),
    openAIOutputMime(response.output_format),
    transform,
    context,
  )
  if (transform) {
    response.output_format = 'png'
    const size = response.data?.find((item) => typeof item.size === 'string')?.size
    if (typeof size === 'string') response.size = size
  }
}

async function archiveOutputs(
  taskId: string,
  entries: { item: Record<string, unknown>; dataKey: string; mimeKey: string }[],
  fallbackMime: string,
  transform: OutputTransform | undefined,
  context: ArchiveContext,
) {
  const { store } = context
  const pending: {
    item: Record<string, unknown>
    dataKey: string
    mimeKey: string
    source: StoredImageRef
    index: number
  }[] = []
  const candidates: StoredImageRef[] = []
  let imageIndex = 0
  try {
    for (const { item, dataKey, mimeKey } of entries) {
      const encoded = typeof item[dataKey] === 'string' ? (item[dataKey] as string) : undefined
      const sourceUrl =
        typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : undefined
      if (!encoded && !sourceUrl && !item.object) continue
      const index = imageIndex++
      if (!encoded && !sourceUrl) continue
      const source = encoded
        ? { bytes: Buffer.from(encoded, 'base64'), mime: undefined }
        : await fetchSourceImage(sourceUrl!, context)
      const declared = typeof item[mimeKey] === 'string' ? (item[mimeKey] as string) : undefined
      const mime = detectMediaMime(source.bytes) ?? declared ?? source.mime ?? fallbackMime
      const ref = { object: `${taskId}/${transform ? 'candidate' : 'out'}/${index}`, mime }
      await writeWithRetry(ref.object, source.bytes, mime, store)
      if (transform) candidates.push(ref)
      else {
        item.object = ref.object
        item[mimeKey] = ref.mime
        if (sourceUrl) item.source_url = sourceUrl
        delete item[dataKey]
        delete item.url
      }
      pending.push({ item, dataKey, mimeKey, source: ref, index })
    }
    // 全部原始候选先落盘；一张无法应用时，其余已生成的候选仍可追查。
    if (!transform) return
    for (const { index, item, dataKey, mimeKey, source } of pending) {
      const output = await transform(await store.read(source.object))
      const key = `${taskId}/out/${index}`
      await writeWithRetry(key, output.bytes, output.mime, store)
      item.object = key
      item[mimeKey] = output.mime
      item.masked_edit = { ...output.inspection, candidate: source }
      item.size = `${output.inspection.width}x${output.inspection.height}`
      item.width = output.inspection.width
      item.height = output.inspection.height
      delete item[dataKey]
      delete item.url
      delete item.source_url
    }
  } catch (error) {
    if (!transform || isAbortError(error)) throw error
    throw new MaskedOutputArchiveError(
      error instanceof Error ? error.message : '局部编辑结果无法应用',
      candidates,
      { cause: error },
    )
  }
}

async function fetchSourceImage(
  url: string,
  context: ArchiveContext,
): Promise<{ bytes: Uint8Array; mime?: string }> {
  try {
    const signal = context.signal
      ? AbortSignal.any([context.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000)
    const source = await fetch(url, { signal })
    if (!source.ok) throw new SourceImageFetchError(`source image HTTP ${source.status}`)
    const limit = context.maxBytes ?? Number.POSITIVE_INFINITY
    if (Number(source.headers.get('content-length') ?? 0) > limit) {
      await source.body?.cancel()
      throw new SourceImageFetchError('source image exceeds size limit')
    }
    if (!source.body) throw new SourceImageFetchError('source image body missing')
    const reader = source.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.length
        if (length > limit) throw new SourceImageFetchError('source image exceeds size limit')
        chunks.push(part.value)
      }
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return {
      bytes,
      mime: source.headers.get('content-type') ?? undefined,
    }
  } catch (error) {
    // 连接失败与读 body 中断都在这里落网；!ok 已经是目标类型，包第二层会丢 status。
    if (error instanceof SourceImageFetchError) throw error
    throw new SourceImageFetchError('source image fetch failed', { cause: error })
  }
}

async function archiveGeminiOutput(
  taskId: string,
  payload: object,
  transform: OutputTransform | undefined,
  context: ArchiveContext,
): Promise<void> {
  const response = payload as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: Record<string, unknown> }> } }>
  }
  const entries = (response.candidates ?? []).flatMap((candidate) =>
    (candidate.content?.parts ?? []).flatMap((part) =>
      part.inlineData ? [{ item: part.inlineData, dataKey: 'data', mimeKey: 'mimeType' }] : [],
    ),
  )
  await archiveOutputs(taskId, entries, 'image/png', transform, context)
}

async function hydrateObjectRef(ref: StoredImageRef): Promise<string> {
  try {
    const bytes = await (ref.store === 'durable' ? durableMediaStore() : objectStore()).read(
      ref.object,
    )
    return `data:${ref.mime};base64,${Buffer.from(bytes).toString('base64')}`
  } catch (error) {
    throw new ObjectStorageError(`Object storage read failed for ${ref.object}`, { cause: error })
  }
}

async function writeWithRetry(
  key: string,
  bytes: Uint8Array,
  mime: string,
  store: ObjectStore = objectStore(),
): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < STORAGE_WRITE_ATTEMPTS; attempt++) {
    try {
      await store.write(key, bytes, mime)
      return
    } catch (error) {
      if (isAbortError(error)) throw error
      lastError = error
      const delay = STORAGE_RETRY_DELAYS_MS[attempt]
      if (delay !== undefined) await Bun.sleep(delay)
    }
  }
  throw new ObjectStorageError(
    `Object storage write failed for ${key} after ${STORAGE_WRITE_ATTEMPTS} attempts`,
    { cause: lastError },
  )
}

export function decodeDataUrl(value: string): { bytes: Uint8Array; mime: string } {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value)
  if (!match) {
    throw new TypeError('input image must be a data:<mime>;base64,<data> URL')
  }
  return { bytes: Buffer.from(match[2]!, 'base64'), mime: match[1]! }
}

function openAIOutputMime(format: string | undefined): string {
  if (format === 'jpeg' || format === 'jpg') return 'image/jpeg'
  if (format === 'webp') return 'image/webp'
  return 'image/png'
}

export function detectMediaMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  // ISO-BMFF: 4 字节 box size 之后是 'ftyp'。mp4 / mov 共用这个头。
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'video/mp4'
  }
  return undefined
}
