import { OAUTH_LINK_ERROR_QUERY_PARAM, OAUTH_LINK_QUERY_PARAM } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { LoginMethodsPanel } from '../auth/LoginMethodsPanel'
import InspirationCoach from '../features/inspiration/components/InspirationCoach'
import { useInspirationStore } from '../features/inspiration/store'
import LibraryCoach, { useLibraryCoachActive } from '../features/library/components/LibraryCoach'
import { useLibraryStore } from '../features/library/store'
import { useTooltip } from '../hooks/useTooltip'
import {
  PrivateWebHeaderAccountActions,
  PrivateWebHeaderCreditAction,
  PrivateWebReplacesAuthActions,
} from '../lib/privateOverlay'
import { useSyncStatus } from '../lib/sync/status'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { APP_MODE_LABELS, useStore, visibleAppModes } from '../store'
import { LibraryIcon, SettingsIcon, SparkleIcon } from './icons'
import LogoutDialog from './LogoutDialog'
import ViewportTooltip from './ViewportTooltip'

export default function Header() {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loginMethodsOpen, setLoginMethodsOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const auth = useAuth()

  const openInspiration = useInspirationStore((s) => s.openPanel)
  const openLibrary = useLibraryStore((s) => s.openPanel)
  const dismissInspirationCoach = useStore((s) => s.dismissInspirationCoach)
  const inspirationCoachActive = useStore(
    (s) => !s.inspirationCoachDismissed && s.tasks.length === 0,
  )
  const libraryCoachActive = useLibraryCoachActive()
  const inspirationTooltip = useTooltip()
  const libraryTooltip = useTooltip()
  const syncPending = useSyncStatus((s) => s.enabled && (s.pending > 0 || s.status === 'error'))

  // 绑定回跳只回到工作台，面板得靠回跳参数自己重开。
  useEffect(() => {
    if (PrivateWebReplacesAuthActions || !auth.enabled || !auth.user) return
    const params = new URL(window.location.href).searchParams
    if (params.has(OAUTH_LINK_QUERY_PARAM) || params.has(OAUTH_LINK_ERROR_QUERY_PARAM)) {
      setLoginMethodsOpen(true)
    }
  }, [auth.enabled, auth.user])

  useEffect(() => {
    if (!accountMenuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAccountMenuOpen(false)
      accountMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [accountMenuOpen])

  const openSettings = () => {
    dismissAllTooltips()
    setAccountMenuOpen(false)
    setShowSettings(true)
  }

  return (
    <>
      <header
        data-no-drag-select
        className="safe-area-top fixed top-0 left-0 right-0 z-40 bg-white/90 dark:bg-gray-950/90 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]"
      >
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto grid grid-cols-[minmax(0,1fr)_auto] grid-rows-[3.5rem_2.5rem] items-center gap-x-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:grid-rows-[4rem]">
          <h1 className="min-w-0">
            <button
              type="button"
              onClick={() => setAppMode('browse')}
              aria-label="Image Playground，返回工作台"
              className="inline-flex max-w-full items-center gap-2.5 rounded-lg font-display text-[18px] font-medium tracking-wide text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-50"
            >
              <img
                src="/pwa-icon.svg"
                alt=""
                width="24"
                height="24"
                className="h-6 w-6 rounded-md shrink-0"
              />
              <span className="hidden truncate sm:inline">Image Playground</span>
            </button>
          </h1>
          <nav
            aria-label="主导航"
            className="col-span-2 row-start-2 mb-2 flex items-center justify-self-center gap-0.5 rounded-xl bg-gray-100/80 p-1 dark:bg-white/[0.04] lg:col-span-1 lg:col-start-2 lg:row-start-1 lg:mb-0"
          >
            {visibleAppModes().map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAppMode(mode)}
                className={`h-8 px-3 text-[13px] font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  appMode === mode
                    ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-50 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                }`}
                aria-pressed={appMode === mode}
              >
                {APP_MODE_LABELS[mode]}
              </button>
            ))}
          </nav>
          <div className="col-start-2 row-start-1 flex items-center gap-1 justify-self-end lg:col-start-3">
            <div className="relative" {...inspirationTooltip.handlers}>
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  dismissInspirationCoach()
                  openInspiration()
                }}
                className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${inspirationCoachActive ? 'animate-coach-pulse' : ''}`}
                aria-label="灵感库"
              >
                <SparkleIcon
                  className={`h-[18px] w-[18px] ${inspirationCoachActive ? 'text-blue-500' : 'text-gray-600 dark:text-gray-400'}`}
                />
              </button>
              <ViewportTooltip visible={inspirationTooltip.visible} className="whitespace-nowrap">
                灵感库
              </ViewportTooltip>
              {inspirationCoachActive && <InspirationCoach />}
            </div>
            <div className="relative" {...libraryTooltip.handlers}>
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  openLibrary()
                }}
                className={`grid h-9 w-9 place-items-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${libraryCoachActive ? 'animate-coach-pulse' : ''}`}
                aria-label="素材与模板"
              >
                <LibraryIcon
                  className={`h-[18px] w-[18px] ${libraryCoachActive ? 'text-blue-500' : 'text-gray-600 dark:text-gray-400'}`}
                />
              </button>
              <ViewportTooltip visible={libraryTooltip.visible} className="whitespace-nowrap">
                素材与模板
              </ViewportTooltip>
              <LibraryCoach />
            </div>
            <div className="ml-2 flex items-center gap-2 border-l border-gray-200 pl-3 dark:border-white/[0.08]">
              <PrivateWebHeaderCreditAction />
              <PrivateWebHeaderAccountActions
                username={auth.user?.username ?? null}
                loggingOut={loggingOut}
                syncPending={syncPending}
                onOpenSettings={openSettings}
                onLogout={() => setLogoutOpen(true)}
              />
              {!PrivateWebReplacesAuthActions ? (
                <div ref={accountMenuRef} className="relative">
                  <button
                    type="button"
                    onClick={() => setAccountMenuOpen((open) => !open)}
                    aria-label={auth.user ? '打开个人账户' : '打开应用菜单'}
                    aria-expanded={accountMenuOpen}
                    className="relative grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-blue-500 to-violet-600 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                  >
                    {auth.user ? (
                      Array.from(auth.user.username)[0]?.toUpperCase()
                    ) : (
                      <SettingsIcon className="h-4 w-4" aria-hidden="true" />
                    )}
                    {syncPending ? (
                      <span
                        role="img"
                        aria-label="有未同步项"
                        className="absolute right-0 top-0 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-white dark:ring-gray-950"
                      />
                    ) : null}
                  </button>
                  {accountMenuOpen ? (
                    <div className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-1.5 text-sm shadow-xl dark:border-white/10 dark:bg-gray-900">
                      {auth.user ? (
                        <div className="truncate px-3 py-2 font-medium text-gray-900 dark:text-gray-100">
                          {auth.user.username}
                        </div>
                      ) : null}
                      <button
                        type="button"
                        onClick={openSettings}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                      >
                        <SettingsIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                        <span>设置</span>
                        {syncPending ? (
                          <span
                            role="img"
                            aria-label="有未同步项"
                            className="ml-auto h-1.5 w-1.5 rounded-full bg-amber-500"
                          />
                        ) : null}
                      </button>
                      {auth.enabled && auth.user ? (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setAccountMenuOpen(false)
                              setLoginMethodsOpen(true)
                            }}
                            className="block w-full rounded-lg px-3 py-2.5 text-left text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                          >
                            登录方式
                          </button>
                          <button
                            type="button"
                            disabled={loggingOut}
                            onClick={() => {
                              setAccountMenuOpen(false)
                              setLogoutOpen(true)
                            }}
                            className="block w-full rounded-lg px-3 py-2.5 text-left text-gray-600 hover:bg-gray-100 disabled:cursor-wait disabled:opacity-50 dark:text-gray-300 dark:hover:bg-white/[0.06]"
                          >
                            {loggingOut ? '退出中' : '退出登录'}
                          </button>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <div className="safe-area-top invisible pointer-events-none" aria-hidden="true">
        <div className="safe-header-inner" />
      </div>
      {loginMethodsOpen && <LoginMethodsPanel onClose={() => setLoginMethodsOpen(false)} />}
      {logoutOpen && (
        <LogoutDialog
          onCancel={() => setLogoutOpen(false)}
          onConfirm={(clearLocalData) => {
            setLogoutOpen(false)
            setLoggingOut(true)
            void auth.logout(clearLocalData)
          }}
        />
      )}
    </>
  )
}
