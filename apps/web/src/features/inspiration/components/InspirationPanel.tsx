import { useRef } from 'react'
import { CloseIcon, SparkleIcon } from '../../../components/icons'
import { useCloseOnEscape } from '../../../hooks/useCloseOnEscape'
import { usePreventBackgroundScroll } from '../../../hooks/usePreventBackgroundScroll'
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

  const scrollBoundaryRef = useRef<HTMLDivElement>(null)

  useCloseOnEscape(panelOpen, closePanel)
  usePreventBackgroundScroll(panelOpen, scrollBoundaryRef)

  if (!panelOpen) return null

  return (
    <div data-no-drag-select className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={closePanel}
      />
      <div
        ref={scrollBoundaryRef}
        className="relative z-10 w-full max-w-6xl rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex h-[90vh] sm:h-[720px] flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 shrink-0 p-5 border-b border-gray-100 dark:border-white/[0.08]">
          <h3 className="text-lg font-bold text-gray-800 dark:text-gray-100 flex items-center gap-2 shrink-0">
            <SparkleIcon className="w-5 h-5 text-blue-500" />
            灵感库
            <span className="ml-1 text-xs font-normal text-gray-400 dark:text-gray-500">
              {items.length > 0 ? `${items.length} 条` : '加载中…'}
            </span>
          </h3>

          <div className="flex items-center gap-3 flex-1 max-w-sm">
            <div className="relative w-full">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400"
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
                placeholder="搜索标题 / 提示词 / 标签"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/15"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={closePanel}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 shrink-0"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Provider tabs: GPT / Nano Banana / 全部 */}
        <div className="shrink-0 px-5 pt-3 pb-2 border-b border-gray-100 dark:border-white/[0.08]">
          <InspirationProviderTabs />
        </div>

        {/* Body: sidebar + grid */}
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Sidebar */}
          <aside className="hidden shrink-0 border-r border-gray-100 dark:border-white/[0.08] sm:block sm:w-44 overflow-y-auto custom-scrollbar">
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
    </div>
  )
}
