import { useInspirationStore, type InspirationProviderFilter } from '../store'
import type { InspirationItem } from '../types'
import InspirationCard from './InspirationCard'

export default function InspirationGrid() {
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const showDetail = useInspirationStore((s) => s.showDetail)

  const filtered = filterItems(items, selectedProvider, selectedCategory, searchKeyword)

  if (filtered.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-gray-400 dark:text-gray-500">
        {items.length === 0 ? '加载中…' : '没有符合条件的灵感'}
      </div>
    )
  }

  return (
    <ul className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
      {filtered.map((item) => (
        <li key={item.id}>
          <InspirationCard item={item} onClick={() => showDetail(item.id)} />
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
    const haystack = [
      item.title,
      item.description ?? '',
      item.prompt,
      ...(item.tags ?? []),
    ].join(' ').toLowerCase()
    return haystack.includes(kw)
  })
}
