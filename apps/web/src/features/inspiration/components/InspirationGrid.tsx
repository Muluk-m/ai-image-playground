import { useInspirationStore } from '../store'
import InspirationCard from './InspirationCard'

export default function InspirationGrid() {
  const items = useInspirationStore((s) => s.items)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const showDetail = useInspirationStore((s) => s.showDetail)

  const filtered = filterItems(items, selectedCategory, searchKeyword)

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
  items: ReturnType<typeof useInspirationStore.getState>['items'],
  category: string | null,
  keyword: string,
) {
  const kw = keyword.trim().toLowerCase()
  return items.filter((item) => {
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
