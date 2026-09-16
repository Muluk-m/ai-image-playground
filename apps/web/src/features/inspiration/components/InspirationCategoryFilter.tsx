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

function CategoryButton({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-3 py-2 text-left text-sm transition ${
        active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
    </button>
  )
}
