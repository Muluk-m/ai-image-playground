import { authenticatedBffFetch } from './authClient'
import { scopedStorageName } from './authScope'
import { type CachedMedia, getCachedMedia, pruneCachedMedia, putCachedMedia } from './db'
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
async function bounded<T>(work: () => Promise<T>, urgent = false): Promise<T> {
  if (active >= 2) {
    await new Promise<void>((resolve) => {
      const entry: Waiting = { urgent, resume: resolve }
      const firstBackground = urgent ? waiting.findIndex((item) => !item.urgent) : -1
      if (firstBackground >= 0) waiting.splice(firstBackground, 0, entry)
      else waiting.push(entry)
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
async function persist(media: CachedMedia): Promise<void> {
  try {
    await pruneCachedMedia(Math.max(diskBudget - media.bytes, 0))
    await putCachedMedia(media)
  } catch {
    // best effort
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
  variant: Variant = 'original',
  urgent = false,
): Promise<string> {
  const id = mediaIdentity(source)
  if (!id) return source
  const scope = scopedStorageName('media')
  const assertScope = () => {
    if (scope !== scopedStorageName('media')) throw new Error('media_scope_changed')
  }
  const cacheId = `${id}:${variant}`
  const key = `${scope}:${cacheId}`
  const hit = loaded.get(key)
  if (hit) {
    loaded.delete(key)
    loaded.set(key, hit)
    return hit
  }
  const pending = loading.get(key)
  if (pending) return pending
  const operation = (async () => {
    const cached = await getCachedMedia(cacheId).catch(() => undefined)
    assertScope()
    if (cached) {
      const data = await blobDataUrl(new Blob([cached.data], { type: cached.contentType }))
      assertScope()
      remember(key, data)
      return data
    }
    return bounded(async () => {
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
        // 取字节而不是 Blob：落盘存的就是字节，data URL 也由同一份字节换算，只解码一次。
        const bytes = await response.arrayBuffer()
        const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
        const data = await blobDataUrl(new Blob([bytes], { type: contentType }))
        assertScope()
        remember(key, data)
        await persist({
          id: cacheId,
          data: bytes,
          contentType,
          bytes: bytes.byteLength,
          lastUsedAt: Date.now(),
        })
        return data
      }
      throw new Error('media_download_failed')
    }, urgent)
  })()
  loading.set(key, operation)
  try {
    return await operation
  } finally {
    loading.delete(key)
  }
}
