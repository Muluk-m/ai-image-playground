import { useEffect } from 'react'
import { useAuth } from './auth/AuthContext'
import ConfirmDialog from './components/ConfirmDialog'
import DetailModal from './components/DetailModal'
import GenerationHistory from './components/GenerationHistory'
import Header from './components/Header'
import ImageContextMenu from './components/ImageContextMenu'
import InputBar from './components/InputBar'
import Lightbox from './components/Lightbox'
import MaskEditorModal from './components/MaskEditorModal'
import RecentGenerations from './components/RecentGenerations'
import SettingsModal from './components/SettingsModal'
import Sidebar from './components/Sidebar'
import TaskBulkActions from './components/TaskBulkActions'
import Toast from './components/Toast'
import UpdateBanner from './components/UpdateBanner'
import CanvasMode from './features/canvas/components/CanvasMode'
import { installProjectNavigation } from './features/canvas/lib/projectNavigation'
import InspirationPanel from './features/inspiration/components/InspirationPanel'
import { initHashRoute } from './features/inspiration/lib/hashRoute'
import LibraryPage from './features/library/components/LibraryPage'
import SaveAssetDialog from './features/library/components/SaveAssetDialog'
import SaveTemplateDialog from './features/library/components/SaveTemplateDialog'
import VideoHome from './features/video/components/VideoHome'
import { i18next } from './i18n'
import { installAppRouting } from './lib/appRoute'
import { isByokGenerationEnabled } from './lib/clientCapabilities'
import { startSyncEngine } from './lib/sync/engine'
import {
  buildSettingsFromUrlParams,
  clearUrlSettingParams,
  hasUrlSettingParams,
} from './lib/urlSettings'
import { initStore, useStore } from './store'

export default function App({ adoptedTaskCount = 0 }: { adoptedTaskCount?: number }) {
  const setSettings = useStore((s) => s.setSettings)
  const appMode = useStore((s) => s.appMode)
  const user = useAuth().user

  useEffect(installAppRouting, [])
  useEffect(installProjectNavigation, [])

  // 匿名设备没有同步；能力关不关由引擎自己判断。
  useEffect(() => (user ? startSyncEngine() : undefined), [user])

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search)
    let nextSettings = buildSettingsFromUrlParams(useStore.getState().settings, searchParams)
    if (!isByokGenerationEnabled()) {
      const builtin = nextSettings.profiles?.find((profile) => profile.source === 'builtin-edge')
      if (builtin) nextSettings = { ...nextSettings, activeProfileId: builtin.id }
    }

    setSettings(nextSettings)

    if (hasUrlSettingParams(searchParams)) {
      clearUrlSettingParams(searchParams)

      const nextSearch = searchParams.toString()
      const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', nextUrl)
    }

    initStore()
    initHashRoute()

    if (adoptedTaskCount > 0) {
      useStore
        .getState()
        .showToast(
          i18next.t('toast.historyAdopted', { ns: 'shell', count: adoptedTaskCount }),
          'success',
        )
    }
  }, [setSettings, adoptedTaskCount])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    // 松手落在落点外时浏览器会直接打开这张图，把整个工作台顶掉。
    const swallowStrayFileDrop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    document.addEventListener('dragover', swallowStrayFileDrop)
    document.addEventListener('drop', swallowStrayFileDrop)
    return () => {
      document.removeEventListener('dragstart', preventPageImageDrag)
      document.removeEventListener('dragover', swallowStrayFileDrop)
      document.removeEventListener('drop', swallowStrayFileDrop)
    }
  }, [])

  return (
    <>
      <Header />
      <Sidebar />
      <div style={{ paddingLeft: 'var(--app-sidebar-width)' }}>
        {appMode === 'canvas' ? (
          <CanvasMode />
        ) : appMode === 'video' ? (
          <VideoHome />
        ) : appMode === 'assets' || appMode === 'templates' || appMode === 'projects' ? (
          <LibraryPage kind={appMode} />
        ) : (
          <>
            <main data-home-main data-drag-select-surface className="pb-48">
              <div className="safe-area-x max-w-7xl mx-auto">
                {appMode === 'image' ? (
                  <RecentGenerations key={user?.id ?? 'anonymous'} userId={user?.id} />
                ) : (
                  <GenerationHistory key={user?.id ?? 'anonymous'} userId={user?.id} />
                )}
              </div>
            </main>
            <TaskBulkActions />
            {appMode === 'image' ? <InputBar /> : null}
          </>
        )}
      </div>
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <InspirationPanel />
      <SaveAssetDialog />
      <SaveTemplateDialog />
      <ConfirmDialog />
      <Toast />
      <UpdateBanner />
      <MaskEditorModal />
      <ImageContextMenu />
    </>
  )
}
