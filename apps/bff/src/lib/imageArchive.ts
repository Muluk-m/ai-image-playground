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

    let bytes: Uint8Array
    let mime = openAIOutputMime(response.output_format)
    if (encoded) {
      bytes = Buffer.from(encoded, 'base64')
    } else {
      const source = await fetch(sourceUrl!)
      if (!source.ok) {
        throw new ObjectStorageError(
          `Object storage output archive failed: source image HTTP ${source.status}`,
        )
      }
      bytes = new Uint8Array(await source.arrayBuffer())
      mime = source.headers.get('content-type') ?? mime
    }

    const key = `${taskId}/out/${index}`
    await writeWithRetry(key, bytes, mime)
    item.object = key
    item.mime = mime
    if (sourceUrl) item.source_url = sourceUrl
    delete item.b64_json
    delete item.url
    index++
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
      const mime = typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png'
      const key = `${taskId}/out/${index}`
      await writeWithRetry(key, Buffer.from(inline.data, 'base64'), mime)
      inline.object = key
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
