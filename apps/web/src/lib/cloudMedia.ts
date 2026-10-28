import { authenticatedBffFetch } from './authClient'
import { scopedStorageName } from './authScope'
import {
  type CachedMedia,
  dbTransaction,
  getCachedMedia,
  pruneCachedMedia,
  putCachedMedia,
  STORE_MEDIA,
} from './db'
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
const bypassDiskCache = new Set<string>()
let cacheSize = 0
const CACHE_BYTES = 32 * 1024 * 1024
/**
 * 落盘的云媒体上限。媒体身份不可变，所以缓存不失效，只按最久未用腾地方。
 * 省的是 R2 出口带宽与用户的等待：同一张图看第二次不该再下一次。
 */
let diskBudget = 512 * 1024 * 1024

/** 浏览器存储被清空或配额收紧时，缓存只是退化成回源，不该让取图失败。 */
export function setMediaDiskBudgetForTesting(bytes: number): void {
  diskBudget = bytes
}
let active = 0
interface Waiting {
  /** 用户点出来的取图排在前面。 */
  urgent: boolean
  resume: () => void
}
const waiting: Waiting[] = []

/**
 * 同时最多两路回源。作品页一进来就在铺几十张预览，用户这时点「复用配置」「编辑」「看原图」，
 * 要取的那几张会排在整页预览后面——2026-09-22 生产实测，刚加载完就点复用要等 21s。
 * 所以队列分两档：用户点出来的插到所有背景预览之前，背景之间仍按先来后到。
 */
/** 还在排队的回源按缓存键记着，后来的 urgent 调用复用同一请求时能把它提到前面。 */
const queued = new Map<string, Waiting>()
/** urgent 来时同一请求还在查本机缓存、没进队列：先记下来，入队时就按 urgent 排。 */
const urgentIntent = new Set<string>()

function enqueue(entry: Waiting): void {
  const firstBackground = entry.urgent ? waiting.findIndex((item) => !item.urgent) : -1
  if (firstBackground >= 0) waiting.splice(firstBackground, 0, entry)
  else waiting.push(entry)
}

function promote(key: string): void {
  const entry = queued.get(key)
  if (!entry || entry.urgent) return
  const index = waiting.indexOf(entry)
  // 已出队、正等被唤醒的那一路不在 waiting 里了，不能 splice(-1) 误删队尾别人的请求。
  if (index < 0) return
  waiting.splice(index, 1)
  entry.urgent = true
  enqueue(entry)
}

async function bounded<T>(work: () => Promise<T>, urgent = false, key?: string): Promise<T> {
  if (active >= 2) {
    await new Promise<void>((resolve) => {
      const entry: Waiting = {
        urgent,
        resume: () => {
          // 出队即同步摘掉，避免唤醒前的微任务窗口里还能被 promote 找到。
          if (key && queued.get(key) === entry) queued.delete(key)
          resolve()
        },
      }
      if (key) queued.set(key, entry)
      enqueue(entry)
    })
  } else active++
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next.resume()
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

export async function mediaJson<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<T> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/media${path}`, {
    ...init,
    cache: 'no-store',
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs),
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

/** Discard only a failed preview; originals and attachment upload leases remain untouched. */
export async function invalidateMediaPreview(source: string): Promise<void> {
  const id = mediaIdentity(source)
  if (!id) return
  const scope = scopedStorageName('media')
  const cacheId = `${id}:preview`
  const key = `${scope}:${cacheId}`
  await loading.get(key)?.catch(() => {})
  if (scope !== scopedStorageName('media')) throw new Error('media_scope_changed')
  const previous = loaded.get(key)
  if (previous) {
    cacheSize -= previous.length
    loaded.delete(key)
  }
  bypassDiskCache.add(key)
  // Until a replacement arrives, retries bypass disk and any original used for display.
  await dbTransaction(STORE_MEDIA, 'readwrite', (store) => store.delete(cacheId)).catch(() => {})
}

/** 会话内的热表：落盘的是 Blob，这里存换算好的 data URL，省掉重复解码。 */
function remember(key: string, data: string): void {
  if (data.length > CACHE_BYTES) return
  while (cacheSize + data.length > CACHE_BYTES && loaded.size) {
    const oldest = loaded.keys().next().value!
    cacheSize -= loaded.get(oldest)!.length
    loaded.delete(oldest)
  }
  loaded.set(key, data)
  cacheSize += data.length
}

/** 缓存是尽力而为：配额满、隐私模式、库被清掉都只该退化成回源，不该让取图失败。 */
async function persist(media: CachedMedia): Promise<boolean> {
  try {
    await pruneCachedMedia(Math.max(diskBudget - media.bytes, 0))
    await putCachedMedia(media)
    return true
  } catch {
    return false
  }
}

/**
 * Stable media identities remain in documents; expiring URLs only live for this request.
 *
 * 三级：会话热表 → 本机缓存（`media` 表）→ 回源。媒体身份不可变，所以本机命中不必校验新鲜度；
 * 只有真回源才占限流名额，`urgent` 是用户当场点出来的那几张，插在正在铺的背景预览之前。
 */
export async function resolveMediaSource(
  source: string,
  variant: Variant | 'display' = 'original',
  urgent = false,
): Promise<string> {
  const id = mediaIdentity(source)
  if (!id) return source
  const reuseOriginal = variant === 'display'
  if (variant === 'display') variant = 'preview'
  const scope = scopedStorageName('media')
  const assertScope = () => {
    if (scope !== scopedStorageName('media')) throw new Error('media_scope_changed')
  }
  const cacheId = `${id}:${variant}`
  const key = `${scope}:${cacheId}`
  // Display can reuse already downloaded pixels; it never fetches an original for a thumbnail.
  const hitKey =
    reuseOriginal && !loaded.has(key) && !bypassDiskCache.has(key) ? `${scope}:${id}:original` : key
  const hit = loaded.get(hitKey)
  if (hit) {
    loaded.delete(hitKey)
    loaded.set(hitKey, hit)
    return hit
  }
  const pending = loading.get(key)
  if (pending) {
    if (urgent) {
      urgentIntent.add(key)
      promote(key)
    }
    return pending
  }
  const operation = (async () => {
    const cached = bypassDiskCache.has(key)
      ? undefined
      : await getCachedMedia(cacheId).catch(() => undefined)
    assertScope()
    if (cached) {
      const data = await blobDataUrl(new Blob([cached.data], { type: cached.contentType }))
      assertScope()
      remember(key, data)
      return data
    }
    return bounded(
      async () => {
        assertScope()
        const deadline = variant === 'original' ? new AbortController() : undefined
        const timer = deadline
          ? setTimeout(
              () => deadline.abort(new DOMException('Media download timed out', 'TimeoutError')),
              300_000,
            )
          : undefined
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            let stage: 'access' | 'fetch' | 'body' = 'access'
            try {
              deadline?.signal.throwIfAborted()
              const access = await mediaJson<Access>(`/${id}/access`, { signal: deadline?.signal })
              assertScope()
              stage = 'fetch'
              const response = await fetch(
                variant === 'preview' ? access.previewUrl : access.originalUrl,
                {
                  credentials: 'omit',
                  signal: deadline?.signal ?? AbortSignal.timeout(30_000),
                },
              )
              assertScope()
              if (!response.ok) {
                void response.body?.cancel().catch(() => {})
                throw new MediaRequestError(response.status, 'media_download_failed')
              }
              stage = 'body'
              const bytes = await response.arrayBuffer()
              const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
              const data = await blobDataUrl(new Blob([bytes], { type: contentType }))
              assertScope()
              deadline?.signal.throwIfAborted()
              remember(key, data)
              if (
                await persist({
                  id: cacheId,
                  data: bytes,
                  contentType,
                  bytes: bytes.byteLength,
                  lastUsedAt: Date.now(),
                })
              )
                bypassDiskCache.delete(key)
              return data
            } catch (error) {
              assertScope()
              deadline?.signal.throwIfAborted()
              // Refresh signed URLs on expiry; original downloads also recover interrupted bodies
              // and temporary API/storage failures, before any bytes enter the cache.
              const expired =
                stage === 'fetch' && error instanceof MediaRequestError && error.status === 403
              const network =
                error instanceof TypeError && (stage === 'fetch' || variant === 'original')
              const transientOriginal =
                variant === 'original' &&
                ((error instanceof MediaRequestError &&
                  [408, 429, 500, 502, 503, 504].includes(error.status)) ||
                  (error instanceof DOMException &&
                    (error.name === 'AbortError' || error.name === 'TimeoutError')))
              if (attempt === 0 && (expired || network || transientOriginal)) continue
              throw error
            }
          }
          throw new Error('media_download_failed')
        } finally {
          clearTimeout(timer)
        }
      },
      urgent || urgentIntent.has(key),
      key,
    )
  })()
  loading.set(key, operation)
  try {
    return await operation
  } finally {
    loading.delete(key)
    urgentIntent.delete(key)
  }
}
