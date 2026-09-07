import { useEffect } from 'react'
import { useAuth } from './auth/AuthContext'
import ConfirmDialog from './components/ConfirmDialog'
import DetailModal from './components/DetailModal'
import Header from './components/Header'
import ImageContextMenu from './components/ImageContextMenu'
import InputBar from './components/InputBar'
import Lightbox from './components/Lightbox'
import MaskEditorModal from './components/MaskEditorModal'
import SearchBar from './components/SearchBar'
import SettingsModal from './components/SettingsModal'
import TaskGrid from './components/TaskGrid'
import Toast from './components/Toast'
import UpdateBanner from './components/UpdateBanner'
import CanvasMode from './features/canvas/components/CanvasMode'
import InspirationPanel from './features/inspiration/components/InspirationPanel'
import { initHashRoute } from './features/inspiration/lib/hashRoute'
import LibraryPanel from './features/library/components/LibraryPanel'
import SaveAssetDialog from './features/library/components/SaveAssetDialog'
import SaveTemplateDialog from './features/library/components/SaveTemplateDialog'
import ProductShotsMode from './features/productShots/components/ProductShotsMode'
import VideoMode from './features/video/components/VideoMode'
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
      useStore.getState().showToast(`已找回登录前的 ${adoptedTaskCount} 条历史`, 'success')
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
      {appMode === 'create' ? (
        <CanvasMode />
      ) : appMode === 'product' ? (
        <ProductShotsMode />
      ) : appMode === 'video' ? (
        <VideoMode />
      ) : (
        <>
          <main data-home-main data-drag-select-surface className="pb-48">
            <div className="safe-area-x max-w-7xl mx-auto">
              <SearchBar />
              <TaskGrid />
            </div>
          </main>
          <InputBar />
        </>
      )}
      <DetailModal />
      <Lightbox />
      <SettingsModal />
      <InspirationPanel />
      <LibraryPanel />
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
