import { useEffect, useRef } from 'react'
import { useAuth } from './auth/AuthContext'
import { resumePendingSubmission } from './auth/resumePendingSubmission'
import ConfirmDialog from './components/ConfirmDialog'
import CreateTargetSwitch from './components/CreateTargetSwitch'
import DetailModal from './components/DetailModal'
import GenerationHistory from './components/GenerationHistory'
import Header from './components/Header'
import ImageContextMenu from './components/ImageContextMenu'
import InputBar from './components/InputBar'
import Lightbox from './components/Lightbox'
import MaskEditorModal from './components/MaskEditorModal'
import SettingsModal from './components/SettingsModal'
import Sidebar from './components/Sidebar'
import TaskBulkActions from './components/TaskBulkActions'
import Toast from './components/Toast'
import UpdateBanner from './components/UpdateBanner'
import CanvasMode from './features/canvas/components/CanvasMode'
import HeroCanvasProjects from './features/canvas/components/HeroCanvasProjects'
import { installProjectNavigation } from './features/canvas/lib/projectNavigation'
import ExplorePage from './features/inspiration/components/ExplorePage'
import InspirationChips from './features/inspiration/components/InspirationChips'
import { initHashRoute } from './features/inspiration/lib/hashRoute'
import LibraryPage from './features/library/components/LibraryPage'
import SaveAssetDialog from './features/library/components/SaveAssetDialog'
import SaveTemplateDialog from './features/library/components/SaveTemplateDialog'
import ToolboxPage from './features/toolbox/components/ToolboxPage'
import { i18next, useTranslation } from './i18n'
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
  const createTarget = useStore((s) => s.createTarget)
  const user = useAuth().user
  const { t } = useTranslation('shell')
  const homeBackdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    document.dispatchEvent(new Event('app:boot-ready'))
  }, [])

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

    void initStore().then(() => {
      if (user) return resumePendingSubmission()
    })
    initHashRoute()

    if (adoptedTaskCount > 0) {
      useStore
        .getState()
        .showToast(
          i18next.t('toast.historyAdopted', { ns: 'shell', count: adoptedTaskCount }),
          'success',
        )
    }
  }, [setSettings, adoptedTaskCount, user])

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
        ) : appMode === 'explore' ? (
          <ExplorePage />
        ) : appMode === 'library' ? (
          <LibraryPage />
        ) : appMode === 'tools' ? (
          <ToolboxPage />
        ) : (
          <>
            <main
              data-home-main
              data-drag-select-surface
              className="relative pb-24"
              onPointerMove={(event) => {
                if (event.pointerType !== 'mouse') return
                const backdrop = homeBackdropRef.current
                if (!backdrop) return
                const bounds = backdrop.getBoundingClientRect()
                if (event.clientY > bounds.bottom) {
                  backdrop.removeAttribute('data-pointer-active')
                  return
                }
                backdrop.style.setProperty('--pointer-x', `${event.clientX - bounds.left}px`)
                backdrop.style.setProperty('--pointer-y', `${event.clientY - bounds.top}px`)
                backdrop.dataset.pointerActive = 'true'
              }}
              onPointerLeave={() => homeBackdropRef.current?.removeAttribute('data-pointer-active')}
            >
              <div ref={homeBackdropRef} aria-hidden="true" className="studio-home-backdrop">
                <div className="studio-home-backdrop__ambient" />
                <div className="studio-home-backdrop__grid" />
                <div className="studio-home-backdrop__hover" />
              </div>
              <div className="safe-area-x relative mx-auto max-w-6xl">
                <div className="pt-12 text-center">
                  <h1 className="text-[30px] font-semibold leading-tight sm:text-[38px]">
                    {t('hero.titleLead')}
                    <span className="studio-hero-accent">{t('hero.titleAccent')}</span>
                  </h1>
                  <p className="pb-6 pt-2 text-sm text-muted-foreground">{t('hero.subtitle')}</p>
                </div>
                {/* 输入框是首屏的主角：跟着 hero 排在流里，不再吸底。 */}
                <div className="pt-6">
                  <CreateTargetSwitch />
                  <div className="pt-4">
                    <InputBar inline />
                  </div>
                </div>
                <InspirationChips />
                {createTarget !== 'generate' ? (
                  <HeroCanvasProjects experience={createTarget} />
                ) : (
                  <GenerationHistory key={user?.id ?? 'anonymous'} userId={user?.id} hero />
                )}
              </div>
            </main>
            <TaskBulkActions />
          </>
        )}
      </div>
      <DetailModal />
      <Lightbox />
      <SettingsModal />

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
