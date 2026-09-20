import { OAUTH_LINK_ERROR_QUERY_PARAM, OAUTH_LINK_QUERY_PARAM } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { LoginMethodsPanel } from '../auth/LoginMethodsPanel'
import { useInspirationStore } from '../features/inspiration/store'
import { useLibraryStore } from '../features/library/store'
import { useWorkspaceViewport } from '../hooks/useMobileWorkspace'
import { useTooltip } from '../hooks/useTooltip'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import {
  PrivateWebHeaderAccountActions,
  PrivateWebHeaderCreditAction,
  PrivateWebReplacesAuthActions,
} from '../lib/privateOverlay'
import { useSyncStatus } from '../lib/sync/status'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import { APP_MODE_LABELS, useStore, visibleAppModes } from '../store'
import BrandAvatar from './BrandAvatar'
import DisplaySettingsMenuItems from './DisplaySettingsMenuItems'
import { LibraryIcon, SettingsIcon, SparkleIcon } from './icons'
import LogoutDialog from './LogoutDialog'
import ViewportTooltip from './ViewportTooltip'

export default function Header() {
  const { t } = useTranslation('shell')
  useWorkspaceViewport()
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
  const inspirationTooltip = useTooltip()
  const libraryTooltip = useTooltip()
  const syncPending = useSyncStatus((s) => s.enabled && (s.pending > 0 || s.status === 'error'))
  // 中文品牌名后面还跟一个拉丁字标；英文里字标就是品牌名本身，没有第二段可跟。

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
        className="studio-header safe-area-top fixed top-0 left-0 right-0 z-40 border-b"
      >
        <div className="safe-area-x safe-header-inner w-full flex items-center gap-2 sm:gap-4">
          <h1 className="min-w-0 shrink-0">
            <button
              type="button"
              onClick={() => setAppMode('create')}
              aria-label={t('header.homeAria')}
              className="flex max-w-full items-center gap-2.5 rounded-lg font-display text-[18px] font-medium tracking-wide text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src="/brand/muvloom-icon.svg"
                alt=""
                width="28"
                height="28"
                className="h-7 w-7 rounded-lg shrink-0"
              />
              <span className="truncate">
                {t('header.brandName')}
                {brandNeedsWordmark() ? (
                  <span className="ml-2 hidden sm:inline">{BRAND_WORDMARK}</span>
                ) : null}
              </span>
            </button>
          </h1>
          <nav
            aria-label={t('header.nav')}
            className="studio-main-nav flex items-center gap-0.5 rounded-lg bg-muted p-1 sm:ml-4"
          >
            {visibleAppModes().map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setAppMode(mode)}
                className={`h-8 px-2 sm:px-3 text-[13px] font-medium rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  appMode === mode
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={appMode === mode}
              >
                {APP_MODE_LABELS[mode]}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <div className="relative" {...inspirationTooltip.handlers}>
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  openInspiration()
                }}
                className="grid h-9 w-9 place-items-center rounded-lg hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('header.inspiration')}
              >
                <SparkleIcon className={`h-[18px] w-[18px] text-muted-foreground`} />
              </button>
              <ViewportTooltip visible={inspirationTooltip.visible} className="whitespace-nowrap">
                {t('header.inspiration')}
              </ViewportTooltip>
            </div>
            <div className="relative" {...libraryTooltip.handlers}>
              <button
                type="button"
                onClick={() => {
                  dismissAllTooltips()
                  openLibrary('projects')
                }}
                className="flex h-9 items-center gap-2 px-2.5 rounded-lg hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('header.library')}
              >
                <LibraryIcon className={`h-[18px] w-[18px] text-muted-foreground`} />
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {t('header.library')}
                </span>
              </button>
              <ViewportTooltip visible={libraryTooltip.visible} className="whitespace-nowrap">
                {t('header.library')}
              </ViewportTooltip>
            </div>
            <div className="ml-2 flex items-center gap-2 border-l border-border pl-3">
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
                    aria-label={auth.user ? t('header.accountMenu') : t('header.appMenu')}
                    aria-haspopup="menu"
                    aria-expanded={accountMenuOpen}
                    className="relative grid h-8 w-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <BrandAvatar />
                    {syncPending ? (
                      <span
                        role="img"
                        aria-label={t('header.unsynced')}
                        className="absolute right-0 top-0 h-2 w-2 rounded-full bg-warning ring-2 ring-white dark:ring-border"
                      />
                    ) : null}
                  </button>
                  {accountMenuOpen ? (
                    <div
                      role="menu"
                      className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-1.5 text-sm shadow-xl"
                    >
                      <div className="truncate px-3 py-2 font-medium text-foreground">
                        {auth.user?.username ??
                          `${t('header.brandName')}${brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}`}
                      </div>
                      <DisplaySettingsMenuItems
                        itemClassName="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-muted"
                        iconClassName="h-[18px] w-[18px]"
                      />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={openSettings}
                        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-muted"
                      >
                        <SettingsIcon className="h-[18px] w-[18px]" aria-hidden="true" />
                        <span>{t('header.settings')}</span>
                        {syncPending ? (
                          <span
                            role="img"
                            aria-label={t('header.unsynced')}
                            className="ml-auto h-1.5 w-1.5 rounded-full bg-warning"
                          />
                        ) : null}
                      </button>
                      {auth.enabled && auth.user ? (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setAccountMenuOpen(false)
                              setLoginMethodsOpen(true)
                            }}
                            className="block w-full rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-muted"
                          >
                            {t('header.loginMethods')}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={loggingOut}
                            onClick={() => {
                              setAccountMenuOpen(false)
                              setLogoutOpen(true)
                            }}
                            className="block w-full rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-50"
                          >
                            {loggingOut ? t('header.loggingOut') : t('logout.title')}
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
