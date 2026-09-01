import type {
  PersistedSubmitRequest,
  QueueProvider,
  StoredImageRef,
  SubmitRequest,
} from '@image-playground/shared'
import { objectStore } from './objectStore'

export type HydratedSubmitRequest = SubmitRequest

const STORAGE_WRITE_ATTEMPTS = 3
const STORAGE_RETRY_DELAYS_MS = [50, 150] as const

export class ObjectStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ObjectStorageError'
  }
}

/**
 * 归档时回源拉上游结果 URL 失败。`retryable` 让 task-runner 重跑整个 task——赌的是
 * 换一个上游账户返回 b64 而非 URL，代价是重新生一次图，不是重拉一次这个 URL。
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
  const hydrated = { ...request } as HydratedSubmitRequest
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
  return hydrated
}

export async function archiveOutputImages(
  taskId: string,
  provider: QueueProvider,
  payload: unknown,
): Promise<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') {
    throw new ObjectStorageError('Object storage archive failed: upstream payload is not an object')
  }

  try {
    if (provider === 'openai-compat') await archiveOpenAIOutput(taskId, payload)
    else await archiveGeminiOutput(taskId, payload)
    return payload as Record<string, unknown>
  } catch (error) {
    try {
      await objectStore().deletePrefix(`${taskId}/out/`)
    } catch {
      // The database has no references to these objects. Lifecycle cleanup removes any orphan.
    }
    // 必须原样重抛：包一层 ObjectStorageError 会丢掉 SourceImageFetchError 的 retryable。
    if (error instanceof ObjectStorageError) throw error
    throw new ObjectStorageError('Object storage output archive failed', { cause: error })
  }
}

async function archiveOpenAIOutput(taskId: string, payload: object): Promise<void> {
  const response = payload as {
    data?: Array<Record<string, unknown>>
    output_format?: string
  }
  let index = 0
  for (const item of response.data ?? []) {
    const encoded = typeof item.b64_json === 'string' ? item.b64_json : undefined
    const sourceUrl =
      typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : undefined
    if (!encoded && !sourceUrl) continue

    const source: { bytes: Uint8Array; mime?: string } = encoded
      ? { bytes: Buffer.from(encoded, 'base64') }
      : await fetchSourceImage(sourceUrl!)
    const mime =
      detectImageMime(source.bytes) ?? source.mime ?? openAIOutputMime(response.output_format)

    const key = `${taskId}/out/${index}`
    await writeWithRetry(key, source.bytes, mime)
    item.object = key
    item.mime = mime
    if (sourceUrl) item.source_url = sourceUrl
    delete item.b64_json
    delete item.url
    index++
  }
}

async function fetchSourceImage(url: string): Promise<{ bytes: Uint8Array; mime?: string }> {
  try {
    const source = await fetch(url)
    if (!source.ok) throw new SourceImageFetchError(`source image HTTP ${source.status}`)
    return {
      bytes: new Uint8Array(await source.arrayBuffer()),
      mime: source.headers.get('content-type') ?? undefined,
    }
  } catch (error) {
    // 连接失败与读 body 中断都在这里落网；!ok 已经是目标类型，包第二层会丢 status。
    if (error instanceof SourceImageFetchError) throw error
    throw new SourceImageFetchError('source image fetch failed', { cause: error })
  }
}

async function archiveGeminiOutput(taskId: string, payload: object): Promise<void> {
  const response = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: Record<string, unknown> }> }
    }>
  }
  let index = 0
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData
      if (!inline || typeof inline.data !== 'string' || !inline.data) continue
      const bytes = Buffer.from(inline.data, 'base64')
      const declaredMime = typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png'
      const mime = detectImageMime(bytes) ?? declaredMime
      const key = `${taskId}/out/${index}`
      await writeWithRetry(key, bytes, mime)
      inline.object = key
      inline.mimeType = mime
      delete inline.data
      index++
    }
  }
}

async function hydrateObjectRef(ref: StoredImageRef): Promise<string> {
  try {
    const bytes = await objectStore().read(ref.object)
    return `data:${ref.mime};base64,${Buffer.from(bytes).toString('base64')}`
  } catch (error) {
    throw new ObjectStorageError(`Object storage read failed for ${ref.object}`, { cause: error })
  }
}

async function writeWithRetry(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < STORAGE_WRITE_ATTEMPTS; attempt++) {
    try {
      await objectStore().write(key, bytes, mime)
      return
    } catch (error) {
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

function decodeDataUrl(value: string): { bytes: Uint8Array; mime: string } {
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

function detectImageMime(bytes: Uint8Array): string | undefined {
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
  return undefined
}
