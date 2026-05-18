import type { InspirationManifest } from '../types'

const CACHE_KEY = 'inspiration-manifest-cache:v1'

interface CacheEntry {
  manifest: InspirationManifest
  storedAt: number
}

export function readCache(): CacheEntry | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CacheEntry
    if (!parsed.manifest || typeof parsed.storedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function writeCache(manifest: InspirationManifest): void {
  if (typeof localStorage === 'undefined') return
  try {
    const entry: CacheEntry = { manifest, storedAt: Date.now() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // 容量满或 disabled 时静默失败
  }
}

export function clearCache(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // ignore
  }
}
