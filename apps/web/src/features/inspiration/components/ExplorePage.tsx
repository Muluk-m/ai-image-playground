import { useEffect } from 'react'
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
  const detailItemId = useInspirationStore((s) => s.detailItemId)

  // 清单 872KB，站到这一页才拉；已加载过的不重复下载。
  useEffect(() => {
    void useInspirationStore.getState().loadRemote()
  }, [])

  return (
    <main className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.explore}</h1>
        <div className="flex-1">
          <InspirationProviderTabs />
        </div>
        <label className="flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('panel.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <aside className="hidden w-44 shrink-0 overflow-y-auto border-r border-border sm:block">
          <InspirationCategoryFilter />
        </aside>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <InspirationGrid />
        </div>
        {detailItemId && <InspirationDetail />}
      </div>
    </main>
  )
}
