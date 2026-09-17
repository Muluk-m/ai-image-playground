import { CloseIcon, SparkleIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useTranslation } from '../../../i18n'
import { useInspirationStore } from '../store'
import InspirationCategoryFilter from './InspirationCategoryFilter'
import InspirationDetail from './InspirationDetail'
import InspirationGrid from './InspirationGrid'
import InspirationProviderTabs from './InspirationProviderTabs'

export default function InspirationPanel() {
  const panelOpen = useInspirationStore((s) => s.panelOpen)
  const closePanel = useInspirationStore((s) => s.closePanel)
  const items = useInspirationStore((s) => s.items)
  const detailItemId = useInspirationStore((s) => s.detailItemId)
  const searchKeyword = useInspirationStore((s) => s.searchKeyword)
  const setSearch = useInspirationStore((s) => s.setSearch)
  const { t } = useTranslation(['inspiration', 'common'])

  if (!panelOpen) return null

  return (
    <Overlay onClose={closePanel} tier="modal">
      <div className="relative z-10 w-full max-w-6xl rounded-3xl border border-white/50 bg-card/95 shadow-2xl ring-1 ring-black/5 animate-modal-in border-border dark:ring-white/10 flex h-[90vh] sm:h-[720px] flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 shrink-0 p-5 border-b border-border">
          <h3 className="text-lg font-bold text-foreground flex items-center gap-2 shrink-0">
            <SparkleIcon className="w-5 h-5 text-primary" />
            {t('panel.title')}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {items.length > 0 ? t('panel.count', { count: items.length }) : t('list.loading')}
            </span>
          </h3>

          <div className="flex items-center gap-3 flex-1 max-w-sm">
            <div className="relative w-full">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-4.35-4.35M11 17a6 6 0 100-12 6 6 0 000 12z"
                />
              </svg>
              <input
                type="search"
                value={searchKeyword}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('panel.searchPlaceholder')}
                className="w-full rounded-lg border border-border bg-card py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={closePanel}
            className="rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-muted-foreground shrink-0"
            aria-label={t('common:action.close')}
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Provider tabs: GPT / Nano Banana / 全部 */}
        <div className="shrink-0 px-5 pt-3 pb-2 border-b border-border">
          <InspirationProviderTabs />
        </div>

        {/* Body: sidebar + grid */}
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Sidebar */}
          <aside className="hidden shrink-0 border-r border-border sm:block sm:w-44 overflow-y-auto custom-scrollbar">
            <InspirationCategoryFilter />
          </aside>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
            <InspirationGrid />
          </div>

          {/* Detail overlay */}
          {detailItemId && <InspirationDetail />}
        </div>
      </div>
    </Overlay>
  )
}
