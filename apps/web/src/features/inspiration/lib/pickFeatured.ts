import type { ProviderKind } from '../../../lib/channels/types'
import type { InspirationItem } from '../types'

const DEFAULT_COUNT = 3
const DAY_MS = 86_400_000

export interface PickFeaturedOptions {
  /**
   * 限定非 pinned 填补阶段从该 provider 池里挑。pinned 项不受此限制
   * （用户显式置顶高于策略偏好）。不传时不限制。
   */
  preferredProvider?: ProviderKind
}

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
  options: PickFeaturedOptions = {},
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

  const { preferredProvider } = options
  const matchesPreferred = (it: InspirationItem) =>
    !preferredProvider || it.recommendedProvider === preferredProvider

  const remainingByCategory = new Map<string, InspirationItem[]>()
  for (const item of items) {
    if (usedIds.has(item.id)) continue
    if (!matchesPreferred(item)) continue
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

  // 偏好池仍不够（小灵感库或 preferredProvider 池太小）：先从偏好池剩余里凑，
  // 同 category 也允许；再不够才放宽到所有 provider，避免 hero 半空。
  if (result.length < count) {
    const preferredLeftovers = items.filter((it) => !usedIds.has(it.id) && matchesPreferred(it))
    shuffleInPlace(preferredLeftovers, rng)
    while (result.length < count && preferredLeftovers.length > 0) {
      const next = preferredLeftovers.shift()
      if (!next) break
      result.push(next)
      usedIds.add(next.id)
    }
  }
  if (result.length < count && preferredProvider) {
    const allLeftovers = items.filter((it) => !usedIds.has(it.id))
    shuffleInPlace(allLeftovers, rng)
    while (result.length < count && allLeftovers.length > 0) {
      const next = allLeftovers.shift()
      if (!next) break
      result.push(next)
      usedIds.add(next.id)
    }
  }

  return result
}
