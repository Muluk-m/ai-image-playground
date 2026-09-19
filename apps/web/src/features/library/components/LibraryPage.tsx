import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import { APP_MODE_LABELS } from '../../../store'
import ProjectGrid from '../../canvas/components/ProjectGrid'
import { useCanvasProjectStore } from '../../canvas/projectStore'
import { selectVisibleAssets, selectVisibleTemplates, useLibraryStore } from '../store'
import AssetCard from './AssetCard'
import { AssetsEmpty, NoMatch, TemplatesEmpty } from './LibraryEmpty'
import NewAssetButton from './NewAssetButton'
import TemplateCard from './TemplateCard'
import TemplateDetail from './TemplateDetail'

export type LibraryPageKind = 'assets' | 'templates' | 'projects'

/**
 * 素材、模板、项目三个入口的主区。它们和别的入口同一层级：走地址、占同一块主区，
 * 不是盖在工作台上的浮层。
 */
export default function LibraryPage({ kind }: { kind: LibraryPageKind }) {
  const { t } = useTranslation(['library', 'common'])
  const searchKeyword = useLibraryStore((s) => s.searchKeyword)
  const setSearch = useLibraryStore((s) => s.setSearch)
  const assets = useLibraryStore(useShallow(selectVisibleAssets))
  const assetCount = useLibraryStore((s) => s.assets.length)
  const templates = useLibraryStore(useShallow(selectVisibleTemplates))
  const templateCount = useLibraryStore((s) => s.templates.length)
  const importAssetFiles = useLibraryStore((s) => s.importAssetFiles)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const projectError = useCanvasProjectStore((state) => state.error)

  useEffect(() => {
    const library = useLibraryStore.getState()
    library.enterLibraryPage(kind)
    void library.loadAssets()
    void library.loadTemplates()
    if (kind === 'projects')
      void useCanvasProjectStore
        .getState()
        .load()
        .catch(() => {})
    return () => useLibraryStore.getState().leaveLibraryPage()
  }, [kind])

  const saveAssets = (files: File[]) => {
    if (kind === 'assets') void importAssetFiles(files)
  }
  const { dragging, dropZoneProps } = useImageDropZone(saveAssets)
  usePasteImageFiles('library', saveAssets)

  const openFilePicker = () => fileInputRef.current?.click()

  const placeholder =
    kind === 'projects'
      ? t('panel.searchProjects')
      : kind === 'templates'
        ? t('panel.searchTemplates')
        : t('panel.searchAssets')

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS[kind]}</h1>
        <label className="ml-auto flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            value={searchKeyword}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={placeholder}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        {kind === 'assets' && (
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

      {kind === 'projects' ? (
        <div className="min-h-0 flex-1 px-5 pb-10 pt-5">
          {projectError ? (
            <div role="alert" className="py-10 text-sm text-muted-foreground">
              {projectError}
              <button
                type="button"
                className="ml-3 text-primary underline"
                onClick={() =>
                  void useCanvasProjectStore
                    .getState()
                    .load()
                    .catch(() => {})
                }
              >
                {t('panel.reloadProjects')}
              </button>
            </div>
          ) : (
            <ProjectGrid search={searchKeyword} />
          )}
        </div>
      ) : kind === 'templates' ? (
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
