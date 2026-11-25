import { useMemo } from 'react'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { useStore } from '../../../store'
import { visibleInspirationItems } from '../lib/visibleItems'
import { useInspirationStore } from '../store'
import InspirationEmpty from './InspirationEmpty'
import InspirationMasonry from './InspirationMasonry'
import InspirationSkeleton from './InspirationSkeleton'

export { filterItems, sortPinnedFirst } from '../lib/visibleItems'

interface Props {
  scroller: HTMLElement | null
}

export default function InspirationGrid({ scroller }: Props) {
  const items = useInspirationStore((s) => s.items)
  const status = useInspirationStore((s) => s.status)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const selectedGroup = useInspirationStore((s) => s.selectedGroup)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const { t } = useTranslation(['inspiration', 'common'])

  const ordered = useMemo(
    () =>
      visibleInspirationItems({
        items,
        provider: selectedProvider,
        category: selectedCategory,
        group: selectedGroup,
        onlyImageEdits,
        keyword: searchKeyword,
        pinnedIds,
      }),
    [
      items,
      selectedProvider,
      selectedCategory,
      selectedGroup,
      onlyImageEdits,
      searchKeyword,
      pinnedIds,
    ],
  )
  const resetKey = `${selectedProvider}|${selectedGroup ?? ''}|${selectedCategory ?? ''}|${searchKeyword}|${onlyImageEdits}`

  if (items.length === 0 && status !== 'ready' && status !== 'error') {
    return <InspirationSkeleton label={t('list.loading')} />
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <p className="text-body-sm text-muted-foreground">
          {status === 'error' ? t('manifest.loadFailed') : t('list.empty')}
        </p>
        {status === 'error' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void useInspirationStore.getState().loadRemote()}
          >
            <Icon name="refresh" />
            {t('common:action.retry')}
          </Button>
        )}
      </div>
    )
  }
  if (ordered.length === 0) return <InspirationEmpty />

  return <InspirationMasonry items={ordered} scroller={scroller} resetKey={resetKey} />
}
