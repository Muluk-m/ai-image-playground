const STORAGE_KEY = 'image-playground.device_id'
let cached: string | null = null

/**
 * 返回浏览器持久化的匿名设备 ID。首次调用生成 UUID 写 localStorage；
 * 之后命中 in-memory 缓存。隐私模式 / SSR 等读写 localStorage 抛错时，
 * fallback 一个 in-memory ID（重启即新设备，可接受）。
 */
export function getDeviceId(): string {
  if (cached) return cached
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && stored.length >= 8) {
      cached = stored
      return cached
    }
    const fresh = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, fresh)
    cached = fresh
    return cached
  } catch {
    if (!cached) cached = crypto.randomUUID()
    return cached
  }
}
