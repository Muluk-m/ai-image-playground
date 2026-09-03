import { useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CloseIcon, LibraryIcon, PlusIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import {
  type LibraryTab,
  selectVisibleAssets,
  selectVisibleTemplates,
  useLibraryStore,
} from '../store'
import AssetCard from './AssetCard'
import TemplateCard from './TemplateCard'
import TemplateDetail from './TemplateDetail'

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: 'assets', label: '素材' },
  { id: 'templates', label: '模板' },
]

export default function LibraryPanel() {
  const panelOpen = useLibraryStore((s) => s.panelOpen)
  const closePanel = useLibraryStore((s) => s.closePanel)
  const tab = useLibraryStore((s) => s.tab)
  const setTab = useLibraryStore((s) => s.setTab)
  const searchKeyword = useLibraryStore((s) => s.searchKeyword)
  const setSearch = useLibraryStore((s) => s.setSearch)
  const assets = useLibraryStore(useShallow(selectVisibleAssets))
  const assetCount = useLibraryStore((s) => s.assets.length)
  const templates = useLibraryStore(useShallow(selectVisibleTemplates))
  const templateCount = useLibraryStore((s) => s.templates.length)
  const importAssetFiles = useLibraryStore((s) => s.importAssetFiles)
  const fileInputRef = useRef<HTMLInputElement>(null)

  if (!panelOpen) return null

  const counts: Record<LibraryTab, number> = { assets: assetCount, templates: templateCount }

  return (
    <Overlay onClose={closePanel} tier="modal">
      <div className="relative z-10 flex h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in sm:h-[680px] dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-100 p-5 dark:border-white/[0.08]">
          <h3 className="flex shrink-0 items-center gap-2 text-lg font-bold text-gray-800 dark:text-gray-100">
            <LibraryIcon className="h-5 w-5 text-blue-500" />
            素材与模板
          </h3>

          <div className="relative w-full max-w-xs">
            <input
              type="search"
              value={searchKeyword}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tab === 'templates' ? '搜索模板名' : '搜索素材名'}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-100 dark:focus:border-blue-500/50 dark:focus:ring-blue-500/15"
            />
          </div>

          <button
            type="button"
            onClick={closePanel}
            className="shrink-0 rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b border-gray-100 px-5 py-2 dark:border-white/[0.08]">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === id
                  ? 'bg-blue-500/10 font-medium text-blue-700 dark:bg-blue-500/15 dark:text-blue-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.04]'
              }`}
            >
              {label}
              {counts[id] > 0 && (
                <span className="ml-1.5 text-xs text-gray-400 dark:text-gray-500">
                  {counts[id]}
                </span>
              )}
            </button>
          ))}

          {tab === 'assets' && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  void importAssetFiles([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="ml-auto flex items-center gap-1 rounded-lg bg-blue-500/10 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-500/20 dark:bg-blue-500/15 dark:text-blue-300 dark:hover:bg-blue-500/25"
              >
                <PlusIcon className="h-4 w-4" />
                新建素材
              </button>
            </>
          )}
        </div>

        <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
          {tab === 'templates' ? (
            templates.length === 0 ? (
              <p className="pt-16 text-center text-sm text-gray-400 dark:text-gray-500">
                {templateCount === 0
                  ? '还没有模板，在输入框旁点书签图标可存为模板'
                  : '没有匹配的模板'}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => (
                  <TemplateCard key={template.id} template={template} />
                ))}
              </div>
            )
          ) : assets.length === 0 ? (
            <p className="pt-16 text-center text-sm text-gray-400 dark:text-gray-500">
              {assetCount === 0 ? '还没有素材，点「新建素材」或右键图片存为素材' : '没有匹配的素材'}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
              {assets.map((asset) => (
                <AssetCard key={asset.id} asset={asset} />
              ))}
            </div>
          )}
        </div>
      </div>

      <TemplateDetail />
    </Overlay>
  )
}
