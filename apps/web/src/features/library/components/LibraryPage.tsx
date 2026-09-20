import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import {
  type LibraryTab,
  selectVisibleAssets,
  selectVisibleTemplates,
  useLibraryStore,
} from '../store'
import AssetCard from './AssetCard'
import { AssetsEmpty, NoMatch, TemplatesEmpty } from './LibraryEmpty'
import NewAssetButton from './NewAssetButton'
import TemplateCard from './TemplateCard'
import TemplateDetail from './TemplateDetail'

const TABS: readonly LibraryTab[] = ['assets', 'templates']

/**
 * 「资产」入口：自己攒下的料——**素材**（用户自己上传的参考图，多是白底无背景的三视图、产品图）
 * 与**模板**。作品在创作页（那里能接着生成），项目另有一个入口，灵感在「探索」。
 */
export default function LibraryPage() {
  const { t } = useTranslation('library')
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

  useEffect(() => {
    const library = useLibraryStore.getState()
    library.enterLibraryPage()
    void library.loadAssets()
    void library.loadTemplates()
    return () => useLibraryStore.getState().leaveLibraryPage()
  }, [])

  const saveAssets = (files: File[]) => {
    if (tab === 'assets') void importAssetFiles(files)
  }
  const { dragging, dropZoneProps } = useImageDropZone(saveAssets)
  usePasteImageFiles('library', saveAssets)

  const openFilePicker = () => fileInputRef.current?.click()

  const placeholder = tab === 'templates' ? t('panel.searchTemplates') : t('panel.searchAssets')

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.library}</h1>
        <div className="flex items-center gap-1">
          {TABS.map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setTab(one)}
              aria-pressed={tab === one}
              className={`rounded-full px-3 py-1 text-[13px] transition-colors ${
                tab === one
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {t(`tab.${one}`)}
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        {tab === 'assets' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                void importAssetFiles([...(event.target.files ?? [])])
                event.target.value = ''
              }}
            />
            <NewAssetButton onClick={openFilePicker} />
          </>
        )}
      </div>

      {tab === 'templates' ? (
        <div className="min-h-0 flex-1 p-5">
          {templates.length > 0 ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => (
                <TemplateCard key={template.id} template={template} />
              ))}
            </div>
          ) : templateCount > 0 ? (
            <NoMatch label={t('panel.noMatchTemplates')} />
          ) : (
            <TemplatesEmpty />
          )}
        </div>
      ) : (
        // 落点包在滚动容器外面，高亮层才盖住看得见的那一屏，而不是随内容滚走。
        <div {...dropZoneProps} className="relative flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 p-5">
            {assets.length > 0 ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
                {assets.map((asset) => (
                  <AssetCard key={asset.id} asset={asset} />
                ))}
              </div>
            ) : assetCount > 0 ? (
              <NoMatch label={t('panel.noMatchAssets')} />
            ) : (
              <AssetsEmpty onImport={openFilePicker} />
            )}
          </div>
          {dragging && <DropOverlay label={t('panel.dropToSave')} />}
        </div>
      )}

      <TemplateDetail />
    </main>
  )
}
