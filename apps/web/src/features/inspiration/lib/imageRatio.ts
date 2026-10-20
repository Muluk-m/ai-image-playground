import type { InspirationItem } from '../types'
import { clampRatio } from './masonry'

const STORAGE_KEY = 'inspiration-image-ratios:v1'

interface MeasuredSize {
  width: number
  height: number
}

const memory = new Map<string, MeasuredSize>()
let storageRead = false
const stored = new Map<string, MeasuredSize>()

function readStorage(): void {
  if (storageRead || typeof localStorage === 'undefined') return
  storageRead = true
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const width = (value as { w?: unknown }).w
      const height = (value as { h?: unknown }).h
      if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) {
        stored.set(id, { width, height })
      }
    }
  } catch {
    // 容量满或被禁用时按没有缓存处理。
  }
}

function writeStorage(id: string, size: MeasuredSize): void {
  if (typeof localStorage === 'undefined') return
  readStorage()
  stored.set(id, size)
  try {
    const payload: Record<string, { w: number; h: number }> = {}
    for (const [key, value] of stored) payload[key] = { w: value.width, h: value.height }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 写失败不影响这一次的内存比例。
  }
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function sizeFromParams(size: string | undefined): MeasuredSize | null {
  if (!size || size.trim().toLowerCase() === 'auto') return null
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)$/i)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!(width > 0) || !(height > 0)) return null
  return { width, height }
}

function manifestSize(item: InspirationItem): MeasuredSize | null {
  const width = positive(item.thumbWidth) ?? positive(item.width)
  const height = positive(item.thumbHeight) ?? positive(item.height)
  if (!width || !height) return null
  return { width, height }
}

/** 实测缓存 → manifest 宽高 → params.size（非 auto）→ 空。 */
export function dimensionsForItem(item: InspirationItem): MeasuredSize | null {
  const remembered = memory.get(item.id)
  if (remembered) return remembered
  readStorage()
  const cached = stored.get(item.id)
  if (cached) {
    memory.set(item.id, cached)
    return cached
  }
  return manifestSize(item) ?? sizeFromParams(item.params.size)
}

/** 卡片用的高/宽，已经夹在允许范围内。 */
export function ratioForItem(item: InspirationItem): number {
  const size = dimensionsForItem(item)
  if (!size) return clampRatio(3 / 4)
  return clampRatio(size.height / size.width)
}

/** 图片 onLoad 后回写。返回布局要用的夹紧比例。 */
export function rememberRatio(id: string, width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return clampRatio(3 / 4)
  const size = { width, height }
  memory.set(id, size)
  writeStorage(id, size)
  return clampRatio(height / width)
}

const ASPECT_PRESETS: ReadonlyArray<readonly [number, string]> = [
  [1, '1:1'],
  [5 / 4, '5:4'],
  [4 / 3, '4:3'],
  [3 / 2, '3:2'],
  [16 / 10, '16:10'],
  [16 / 9, '16:9'],
  [2, '2:1'],
  [2.35, '2.35:1'],
  [21 / 9, '21:9'],
  [4 / 5, '4:5'],
  [3 / 4, '3:4'],
  [2 / 3, '2:3'],
  [9 / 16, '9:16'],
]

export function aspectLabel(width: number, height: number): string | null {
  if (!(width > 0) || !(height > 0)) return null
  const ratio = width / height
  let best = ASPECT_PRESETS[0]!
  let bestDiff = Number.POSITIVE_INFINITY
  for (const preset of ASPECT_PRESETS) {
    const diff = Math.abs(preset[0] - ratio)
    if (diff < bestDiff) {
      best = preset
      bestDiff = diff
    }
  }
  if (bestDiff / best[0] <= 0.04) return best[1]
  const rounded = Math.round(ratio * 100) / 100
  return `${rounded}:1`
}

export function aspectText(item: InspirationItem): string | null {
  const size = dimensionsForItem(item)
  if (!size) return null
  return aspectLabel(size.width, size.height)
}

/** cms-r2 的缩略图用查询参数换宽度；其他域名保持原图。 */
export function inspirationImageUrl(url: string, width: number): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'cms-r2.deepclick.com') return url
    parsed.searchParams.set('w', String(width))
    return parsed.toString()
  } catch {
    return url
  }
}

export function clearRatioCache(): void {
  memory.clear()
  stored.clear()
  storageRead = false
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
