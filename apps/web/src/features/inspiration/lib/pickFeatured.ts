import type { InspirationItem } from '../types'

const DEFAULT_COUNT = 3
const DAY_MS = 86_400_000

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h) || 1
}

function makeRng(seed: number) {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) | 0
    return ((state >>> 0) % 0x7fffffff) / 0x7fffffff
  }
}

function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/**
 * 为「首页空状态 hero」挑选灵感库示例：
 *
 * 1. 优先用户置顶（pinnedIds）的前 N 张 —— 这是用户最显式的偏好信号。
 * 2. 不足时按 category 多样性补足，每个 category 最多一张；
 *    用「当天日期 + 项目固定盐」作为 seed，让每天看到的可能不同但同一天稳定，
 *    避免每次进入空状态卡片乱跳（用户不舒服）。
 * 3. 多样性补完仍不足（小灵感库时），从剩余里再补，避免 hero 半空。
 */
export function pickFeaturedInspirations(
  items: readonly InspirationItem[],
  pinnedIds: readonly string[],
  count = DEFAULT_COUNT,
  now: number = Date.now(),
): InspirationItem[] {
  if (items.length === 0 || count <= 0) return []

  const idMap = new Map(items.map((it) => [it.id, it]))
  const result: InspirationItem[] = []
  const usedIds = new Set<string>()
  const usedCategories = new Set<string>()

  for (const id of pinnedIds) {
    const item = idMap.get(id)
    if (!item || usedIds.has(item.id)) continue
    result.push(item)
    usedIds.add(item.id)
    usedCategories.add(item.category)
    if (result.length >= count) return result
  }

  const dayBucket = Math.floor(now / DAY_MS)
  const rng = makeRng(hashString(`image-playground-featured-${dayBucket}`))

  const remainingByCategory = new Map<string, InspirationItem[]>()
  for (const item of items) {
    if (usedIds.has(item.id)) continue
    const list = remainingByCategory.get(item.category) ?? []
    list.push(item)
    remainingByCategory.set(item.category, list)
  }

  const freshCategories = shuffleInPlace(
    Array.from(remainingByCategory.keys()).filter((c) => !usedCategories.has(c)),
    rng,
  )

  for (const category of freshCategories) {
    if (result.length >= count) return result
    const pool = remainingByCategory.get(category)
    if (!pool || pool.length === 0) continue
    const idx = Math.floor(rng() * pool.length)
    const pick = pool[idx]
    result.push(pick)
    usedIds.add(pick.id)
  }

  if (result.length < count) {
    const leftovers = items.filter((it) => !usedIds.has(it.id))
    shuffleInPlace(leftovers, rng)
    while (result.length < count && leftovers.length > 0) {
      const next = leftovers.shift()
      if (!next) break
      result.push(next)
      usedIds.add(next.id)
    }
  }

  return result
}
