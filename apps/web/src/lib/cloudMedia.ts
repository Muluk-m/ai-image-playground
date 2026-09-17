import { authenticatedBffFetch } from './authClient'
import { scopedStorageName } from './authScope'
import { bffBaseUrl } from './runtimeConfig'

export function mediaIdentity(source: string | undefined): string | undefined {
  return source?.match(/^aip-media:([0-9a-f-]{36})$/i)?.[1]
}
interface Access {
  originalUrl: string
  previewUrl: string
  expiresAt: number
}
type Variant = 'original' | 'preview'
const loaded = new Map<string, string>()
const loading = new Map<string, Promise<string>>()
let cacheSize = 0
const CACHE_BYTES = 32 * 1024 * 1024
let active = 0
const waiting: (() => void)[] = []

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve))
  else active++
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

export class MediaRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

export async function mediaJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/media${path}`, {
    ...init,
    cache: 'no-store',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new MediaRequestError(response.status, body.error ?? 'media_unavailable')
  }
  return response.json() as Promise<T>
}

export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** Stable media identities remain in documents; expiring URLs only live for this request. */
export async function resolveMediaSource(
  source: string,
  variant: Variant = 'original',
): Promise<string> {
  const id = mediaIdentity(source)
  if (!id) return source
  const scope = scopedStorageName('media')
  const assertScope = () => {
    if (scope !== scopedStorageName('media')) throw new Error('media_scope_changed')
  }
  const key = `${scope}:${id}:${variant}`
  const hit = loaded.get(key)
  if (hit) {
    loaded.delete(key)
    loaded.set(key, hit)
    return hit
  }
  const pending = loading.get(key)
  if (pending) return pending
  const operation = bounded(async () => {
    assertScope()
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await mediaJson<Access>(`/${id}/access`)
      assertScope()
      let response: Response
      try {
        response = await fetch(variant === 'preview' ? access.previewUrl : access.originalUrl, {
          credentials: 'omit',
          signal: AbortSignal.timeout(30000),
        })
      } catch (error) {
        assertScope()
        // R2 omits CORS headers on expired signatures, so browsers expose a network error.
        if (error instanceof TypeError && attempt === 0) continue
        throw error
      }
      assertScope()
      if (response.status === 403 && attempt === 0) continue
      if (!response.ok) throw new MediaRequestError(response.status, 'media_download_failed')
      const data = await blobDataUrl(await response.blob())
      assertScope()
      if (data.length <= CACHE_BYTES) {
        while (cacheSize + data.length > CACHE_BYTES && loaded.size) {
          const oldest = loaded.keys().next().value!
          cacheSize -= loaded.get(oldest)!.length
          loaded.delete(oldest)
        }
        loaded.set(key, data)
        cacheSize += data.length
      }
      return data
    }
    throw new Error('media_download_failed')
  })
  loading.set(key, operation)
  try {
    return await operation
  } finally {
    loading.delete(key)
  }
}
