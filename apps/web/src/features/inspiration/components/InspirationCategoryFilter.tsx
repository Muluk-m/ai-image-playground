import { useMemo } from 'react'
import { useInspirationStore } from '../store'

export default function InspirationCategoryFilter() {
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const setCategory = useInspirationStore((s) => s.setCategory)

  // 分类列表跟随当前 provider 过滤——只看到对应模型下实际存在的分类
  const visibleCategories = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      if (selectedProvider !== 'all' && item.recommendedProvider !== selectedProvider) continue
      if (item.category) set.add(item.category)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [items, selectedProvider])

  return (
    <nav className="flex flex-col gap-1 p-2">
      <CategoryButton
        label="全部"
        active={selectedCategory === null}
        onClick={() => setCategory(null)}
      />
      {visibleCategories.map((category) => (
        <CategoryButton
          key={category}
          label={category}
          active={selectedCategory === category}
          onClick={() => setCategory(category)}
        />
      ))}
    </nav>
  )
}

function CategoryButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-left text-sm transition ${
        active
          ? 'bg-blue-500/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300 font-medium'
          : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
      }`}
    >
      {label}
    </button>
  )
}
