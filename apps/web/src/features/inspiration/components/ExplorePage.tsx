import { useEffect, useRef, useState } from 'react'
import PageHeader from '../../../components/patterns/PageHeader'
import SearchField from '../../../components/patterns/SearchField'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS, useStore } from '../../../store'
import { visibleInspirationItems } from '../lib/visibleItems'
import { useInspirationStore } from '../store'
import InspirationDetail from './InspirationDetail'
import InspirationGrid from './InspirationGrid'
import InspirationGroupChips from './InspirationGroupChips'
import InspirationProviderTabs from './InspirationProviderTabs'

/** 「探索」入口：别人的东西（灵感清单）。自己的东西在「资产」里，两条线不混。 */
export default function ExplorePage() {
  const { t } = useTranslation('inspiration')
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const setSearch = useInspirationStore((s) => s.setSearch)
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const items = useInspirationStore((s) => s.items)
  const selectedProvider = useInspirationStore((s) => s.selectedProvider)
  const selectedCategory = useInspirationStore((s) => s.selectedCategory)
  const selectedGroup = useInspirationStore((s) => s.selectedGroup)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const pinnedIds = useStore((s) => s.pinnedInspirationIds)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    void useInspirationStore.getState().loadRemote()
  }, [])

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    scroller?.scrollTo({ top: 0 })
  }, [selectedProvider, selectedGroup, selectedCategory, searchKeyword, onlyImageEdits, scroller])

  const count = visibleInspirationItems({
    items,
    provider: selectedProvider,
    category: selectedCategory,
    group: selectedGroup,
    onlyImageEdits,
    keyword: searchKeyword,
    pinnedIds,
  }).length

  return (
    <main className="flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px))] flex-col">
      <PageHeader title={APP_MODE_LABELS.explore}>
        <div className="hidden items-center gap-2 md:flex">
          <InspirationProviderTabs />
        </div>
        <div className="relative ml-auto hidden w-full max-w-xs md:block">
          <SearchField
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('panel.searchPlaceholder')}
            className="max-w-none rounded-full bg-card/40 pr-8"
          />
          {searchKeyword ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              autoTooltip={false}
              aria-label={t('list.clearSearch')}
              className="absolute right-1 top-1"
              onClick={() => setSearch('')}
            >
              <Icon name="close" />
            </Button>
          ) : null}
        </div>
      </PageHeader>
      <div className="space-y-3 border-b border-border px-4 py-3 md:hidden">
        <div className="relative">
          <SearchField
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('panel.searchPlaceholder')}
            className="max-w-none rounded-full border-border/80 bg-card/50 pr-8"
          />
          {searchKeyword ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              autoTooltip={false}
              aria-label={t('list.clearSearch')}
              className="absolute right-1 top-1"
              onClick={() => setSearch('')}
            >
              <Icon name="close" />
            </Button>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <InspirationProviderTabs />
        </div>
      </div>
      <div ref={setScroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-3 bg-background/95 px-4 py-2.5 backdrop-blur md:px-4">
          <InspirationGroupChips />
          <span className="hidden shrink-0 text-label-sm text-muted-foreground md:inline">
            {items.length > 0 ? t('list.count', { count }) : ''}
          </span>
        </div>
        <div className="px-4 pb-6">
          <InspirationGrid scroller={scroller} />
        </div>
      </div>
      {detailItemId ? <InspirationDetail /> : null}
    </main>
  )
}
