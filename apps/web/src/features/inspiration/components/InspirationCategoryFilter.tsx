import { useMemo } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { inspirationFacetLabel } from '../lib/labels'
import { useInspirationStore } from '../store'

/** 分类列表跟随当前 provider——只列出这个模型下实际有的分类。 */
export function useVisibleCategories(): string[] {
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  return useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      if (selectedProvider !== 'all' && item.recommendedProvider !== selectedProvider) continue
      if (item.category) set.add(item.category)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }, [items, selectedProvider])
}

export default function InspirationCategoryFilter() {
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const setCategory = useInspirationStore((s) => s.setCategory)
  const { t } = useTranslation('inspiration')
  const visibleCategories = useVisibleCategories()

  return (
    <nav className="flex flex-col gap-1 p-2">
      <CategoryButton
        label={t('filter.all')}
        active={selectedCategory === null}
        onClick={() => setCategory(null)}
      />
      {visibleCategories.map((category) => (
        <CategoryButton
          key={category}
          label={inspirationFacetLabel(category)}
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
    <Button
      type="button"
      onClick={onClick}
      variant={active ? 'secondary' : 'ghost'}
      aria-pressed={active}
      size="sm"
      className="h-auto min-h-8 justify-start whitespace-normal break-words text-left"
    >
      <span className="min-w-0 flex-1">{label}</span>
    </Button>
  )
}
