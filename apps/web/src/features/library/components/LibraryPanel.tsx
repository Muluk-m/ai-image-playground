import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import DropOverlay from '../../../components/DropOverlay'
import { CloseIcon, LibraryIcon } from '../../../components/icons'
import Overlay from '../../../components/Overlay'
import { useImageDropZone } from '../../../hooks/useImageDropZone'
import { usePasteImageFiles } from '../../../hooks/usePasteImageFiles'
import { useTranslation } from '../../../i18n'
import ProjectGrid from '../../canvas/components/ProjectGrid'
import { useCanvasProjectStore } from '../../canvas/projectStore'
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

const TABS: Array<{
  id: LibraryTab
  labelKey: 'panel.tabProjects' | 'panel.tabAssets' | 'panel.tabTemplates'
}> = [
  { id: 'projects', labelKey: 'panel.tabProjects' },
  { id: 'assets', labelKey: 'panel.tabAssets' },
  { id: 'templates', labelKey: 'panel.tabTemplates' },
]

export default function LibraryPanel() {
  const { t } = useTranslation(['library', 'common'])
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
  const projects = useCanvasProjectStore((state) => state.projects)
  const projectError = useCanvasProjectStore((state) => state.error)
  useEffect(() => {
    if (panelOpen)
      void useCanvasProjectStore
        .getState()
        .load()
        .catch(() => {})
  }, [panelOpen])
  const saveAssets = (files: File[]) => {
    if (panelOpen && tab === 'assets') void importAssetFiles(files)
  }
  const { dragging, dropZoneProps } = useImageDropZone(saveAssets)
  usePasteImageFiles('library', saveAssets)

  if (!panelOpen) return null

  const counts: Record<LibraryTab, number> = {
    projects: projects.filter((project) => !project.cloud?.deleted).length,
    assets: assetCount,
    templates: templateCount,
  }
  const openFilePicker = () => fileInputRef.current?.click()

  const renderAssets = () => {
    if (assets.length > 0) {
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
          {assets.map((asset) => (
            <AssetCard key={asset.id} asset={asset} />
          ))}
        </div>
      )
    }
    if (assetCount > 0) return <NoMatch label={t('panel.noMatchAssets')} />
    return <AssetsEmpty onImport={openFilePicker} />
  }

  const renderTemplates = () => {
    if (templates.length > 0) {
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard key={template.id} template={template} />
          ))}
        </div>
      )
    }
    if (templateCount > 0) return <NoMatch label={t('panel.noMatchTemplates')} />
    return <TemplatesEmpty />
  }

  return (
    <Overlay onClose={closePanel} tier="modal" layout="fill" backdrop="none">
      <div className="relative z-10 flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-5 sm:px-10">
          <h3 className="flex shrink-0 items-center gap-2 text-lg font-bold text-foreground">
            <LibraryIcon className="h-5 w-5 text-primary" />
            {t('panel.title')}
          </h3>

          <div className="relative w-full max-w-xs">
            <input
              type="search"
              value={searchKeyword}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                tab === 'projects'
                  ? t('panel.searchProjects')
                  : tab === 'templates'
                    ? t('panel.searchTemplates')
                    : t('panel.searchAssets')
              }
              className="w-full rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <button
            type="button"
            onClick={closePanel}
            className="shrink-0 rounded-full p-1 text-muted-foreground transition hover:bg-muted hover:text-muted-foreground"
            aria-label={t('common:action.close')}
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2 px-5 py-5 sm:px-10">
          {TABS.map(({ id, labelKey }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                tab === id
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t(labelKey)}
              {counts[id] > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">{counts[id]}</span>
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
              <NewAssetButton onClick={openFilePicker} className="ml-auto" />
            </>
          )}
        </div>

        {tab === 'projects' ? (
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-10 sm:px-10">
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
        ) : tab === 'templates' ? (
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
            {renderTemplates()}
          </div>
        ) : (
          // 落点包在滚动容器外面，高亮层才盖住看得见的那一屏，而不是随内容滚走。
          <div {...dropZoneProps} className="relative flex min-h-0 flex-1 flex-col">
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-5">
              {renderAssets()}
            </div>
            {dragging && <DropOverlay label={t('panel.dropToSave')} />}
          </div>
        )}
      </div>

      <TemplateDetail />
    </Overlay>
  )
}
