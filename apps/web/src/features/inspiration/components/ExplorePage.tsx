import { useEffect } from 'react'
import PageHeader from '../../../components/patterns/PageHeader'
import SearchField from '../../../components/patterns/SearchField'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import { useInspirationStore } from '../store'
import InspirationCategoryChips from './InspirationCategoryChips'
import InspirationCategoryFilter from './InspirationCategoryFilter'
import InspirationDetail from './InspirationDetail'
import InspirationGrid from './InspirationGrid'
import InspirationProviderTabs from './InspirationProviderTabs'

/** 「探索」入口：别人的东西（灵感清单）。自己的东西在「资产」里，两条线不混。 */
export default function ExplorePage() {
  const { t } = useTranslation('inspiration')
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const setSearch = useInspirationStore((s) => s.setSearch)
  const onlyImageEdits = useInspirationStore((s) => s.onlyImageEdits)
  const setOnlyImageEdits = useInspirationStore((s) => s.setOnlyImageEdits)
  const detailItemId = useInspirationStore((s) => s.detailItemId)

  // 清单 872KB，站到这一页才拉；已加载过的不重复下载。
  useEffect(() => {
    void useInspirationStore.getState().loadRemote()
  }, [])

  return (
    <main className="flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px))] flex-col">
      <PageHeader title={APP_MODE_LABELS.explore}>
        <div className="hidden items-center gap-2 md:flex">
          <InspirationProviderTabs />
        </div>
        <Button
          type="button"
          aria-pressed={onlyImageEdits}
          onClick={() => setOnlyImageEdits(!onlyImageEdits)}
          variant={onlyImageEdits ? 'secondary' : 'outline'}
          size="xs"
          className="ml-auto hidden shrink-0 md:inline-flex"
        >
          {t('filter.imageEdit')}
        </Button>
        <SearchField
          value={searchKeyword}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('panel.searchPlaceholder')}
          className="hidden max-w-xs rounded-full bg-card/40 md:flex"
        />
      </PageHeader>
      <div className="space-y-3 border-b border-border px-4 py-3 md:hidden">
        <SearchField
          value={searchKeyword}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('panel.searchPlaceholder')}
          className="max-w-none rounded-full border-border/80 bg-card/50"
        />
        <div className="overflow-x-auto">
          <InspirationProviderTabs />
        </div>
        <InspirationCategoryChips />
      </div>
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-border md:block">
          <InspirationCategoryFilter />
        </aside>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:p-6">
          <InspirationGrid />
        </div>
        {detailItemId && <InspirationDetail />}
      </div>
    </main>
  )
}
