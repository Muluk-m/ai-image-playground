import { useEffect } from 'react'
import PageHeader from '../../../components/PageHeader'
import SearchField from '../../../components/SearchField'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import { useInspirationStore } from '../store'
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
    <main className="flex h-dvh flex-col">
      <PageHeader title={APP_MODE_LABELS.explore}>
        <InspirationProviderTabs />
        <button
          type="button"
          aria-pressed={onlyImageEdits}
          onClick={() => setOnlyImageEdits(!onlyImageEdits)}
          className={`ml-auto h-7 shrink-0 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            onlyImageEdits
              ? 'border-primary/60 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
          }`}
        >
          {t('filter.imageEdit')}
        </button>
        <SearchField
          value={searchKeyword}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('panel.searchPlaceholder')}
        />
      </PageHeader>
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-48 shrink-0 overflow-y-auto border-r border-border sm:block">
          <InspirationCategoryFilter />
        </aside>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <InspirationGrid />
        </div>
        {detailItemId && <InspirationDetail />}
      </div>
    </main>
  )
}
