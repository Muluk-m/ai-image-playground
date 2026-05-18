import { useMemo } from 'react'
import { useStore } from '../../../store'
import { type InspirationProviderFilter, useInspirationStore } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'

export default function InspirationGrid() {
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const showDetail = useInspirationStore((s) => s.showDetail)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)

  const ordered = useMemo(
    () =>
      sortPinnedFirst(
        filterItems(items, selectedProvider, selectedCategory, searchKeyword),
        pinnedIds,
      ),
    [items, selectedProvider, selectedCategory, searchKeyword, pinnedIds],
  )
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])

  if (ordered.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        {items.length === 0 ? '加载中…' : '没有符合条件的灵感'}
      </div>
    )
  }

  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {ordered.map((item) => (
        <li key={item.id}>
          <InspirationCard
            item={item}
            pinned={pinnedSet.has(item.id)}
            onClick={() => showDetail(item.id)}
          />
        </li>
      ))}
    </ul>
  )
}

function filterItems(
  items: InspirationItem[],
  provider: InspirationProviderFilter,
  category: string | null,
  keyword: string,
) {
  const kw = keyword.trim().toLowerCase()
  return items.filter((item) => {
    if (provider !== 'all' && item.recommendedProvider !== provider) return false
    if (category && item.category !== category) return false
    if (!kw) return true
    const haystack = [item.title, item.description ?? '', item.prompt, ...(item.tags ?? [])]
      .join(' ')
      .toLowerCase()
    return haystack.includes(kw)
  })
}

/**
 * pinnedIds 顺序 = 用户置顶顺序（最近 pin 的在前）；未匹配到当前 filtered 的 id 跳过。
 */
function sortPinnedFirst(items: InspirationItem[], pinnedIds: string[]): InspirationItem[] {
  if (pinnedIds.length === 0) return items
  const pinnedSet = new Set(pinnedIds)
  const byId = new Map(items.map((it) => [it.id, it] as const))
  const pinned: InspirationItem[] = []
  for (const id of pinnedIds) {
    const hit = byId.get(id)
    if (hit) pinned.push(hit)
  }
  const rest = items.filter((it) => !pinnedSet.has(it.id))
  return [...pinned, ...rest]
}
