import type { InspirationProviderFilter } from '../store'
import type { InspirationItem } from '../types'
import { groupOf, INSPIRATION_GROUPS, type InspirationGroupId } from './groups'
import { inspirationFacetLabel } from './labels'

export function filterItems(
  items: InspirationItem[],
  provider: InspirationProviderFilter,
  category: string | null,
  onlyImageEdits: boolean,
  keyword: string,
  group: InspirationGroupId | null = null,
): InspirationItem[] {
  const kw = keyword.trim().toLowerCase()
  return items.filter((item) => {
    if (provider !== 'all' && item.recommendedProvider !== provider) return false
    if (category && item.category !== category) return false
    if (group && groupOf(item.category) !== group) return false
    if (onlyImageEdits && !item.referenceImages?.length) return false
    if (!kw) return true
    const haystack = [
      item.title,
      item.description ?? '',
      item.prompt,
      item.category,
      inspirationFacetLabel(item.category),
      ...(item.tags ?? []),
      ...(item.tags ?? []).map((tag) => inspirationFacetLabel(tag)),
    ]
      .join(' ')
      .toLowerCase()
    return haystack.includes(kw)
  })
}

/**
 * pinnedIds 顺序 = 用户收藏顺序（最近收藏的在前）；未出现在当前筛选里的 id 跳过。
 */
export function sortPinnedFirst(
  items: InspirationItem[],
  pinnedIds: readonly string[],
): InspirationItem[] {
  if (pinnedIds.length === 0) return items
  const pinnedSet = new Set(pinnedIds)
  const byId = new Map(items.map((item) => [item.id, item] as const))
  const pinned: InspirationItem[] = []
  for (const id of pinnedIds) {
    const hit = byId.get(id)
    if (hit) pinned.push(hit)
  }
  const rest = items.filter((item) => !pinnedSet.has(item.id))
  return [...pinned, ...rest]
}

/** 「全部」下：收藏在前，其余按分组轮流取一条，避免首屏全是同一类。 */
export function interleaveByGroup(
  items: InspirationItem[],
  pinnedIds: readonly string[],
): InspirationItem[] {
  const pinnedSet = new Set(pinnedIds)
  const pinned = items.filter((item) => pinnedSet.has(item.id))
  const buckets = new Map<InspirationGroupId, InspirationItem[]>(
    INSPIRATION_GROUPS.map((group) => [group.id, []]),
  )
  for (const item of items) {
    if (pinnedSet.has(item.id)) continue
    buckets.get(groupOf(item.category))?.push(item)
  }
  const mixed: InspirationItem[] = []
  let progressed = true
  while (progressed) {
    progressed = false
    for (const group of INSPIRATION_GROUPS) {
      const next = buckets.get(group.id)?.shift()
      if (!next) continue
      mixed.push(next)
      progressed = true
    }
  }
  return [...pinned, ...mixed]
}

export function visibleInspirationItems(input: {
  items: InspirationItem[]
  provider: InspirationProviderFilter
  category: string | null
  group: InspirationGroupId | null
  onlyImageEdits: boolean
  keyword: string
  pinnedIds: readonly string[]
}): InspirationItem[] {
  const filtered = filterItems(
    input.items,
    input.provider,
    input.category,
    input.onlyImageEdits,
    input.keyword,
    input.group,
  )
  const ordered = sortPinnedFirst(filtered, input.pinnedIds)
  const browseAll =
    !input.group && !input.category && !input.onlyImageEdits && input.keyword.trim().length === 0
  return browseAll ? interleaveByGroup(ordered, input.pinnedIds) : ordered
}
