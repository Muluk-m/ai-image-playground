import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { inspirationFacetLabel } from '../lib/labels'
import { useInspirationStore } from '../store'
import { useVisibleCategories } from './InspirationCategoryFilter'

/** 窄屏探索页的分类：一行横滑胶囊，桌面侧栏不显示它。 */
export default function InspirationCategoryChips() {
  const visibleCategories = useVisibleCategories()
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const setCategory = useInspirationStore((s) => s.setCategory)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const setOnlyImageEdits = useInspirationStore((s) => s.setOnlyImageEdits)
  const { t } = useTranslation('inspiration')

  const chip = (label: string, active: boolean, onClick: () => void) => (
    <Button
      type="button"
      size="sm"
      variant={active ? 'secondary' : 'outline'}
      aria-pressed={active}
      onClick={onClick}
      className="h-8 shrink-0 rounded-full px-3"
    >
      {label}
    </Button>
  )

  return (
    <div className="explore-chips -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {chip(t('filter.all'), selectedCategory === null, () => setCategory(null))}
      {chip(t('filter.imageEditShort'), onlyImageEdits, () => setOnlyImageEdits(!onlyImageEdits))}
      {visibleCategories.map((category) =>
        chip(inspirationFacetLabel(category), selectedCategory === category, () => {
          setCategory(category)
        }),
      )}
    </div>
  )
}
