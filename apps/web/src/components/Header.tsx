import { OAUTH_LINK_ERROR_QUERY_PARAM, OAUTH_LINK_QUERY_PARAM } from '@image-playground/shared'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { LoginMethodsPanel } from '../auth/LoginMethodsPanel'
import AgentJobInbox from '../features/agent/components/AgentJobInbox'
import { agentPanelPresent } from '../features/agent/panelLayout'
import { useWorkspaceViewport } from '../hooks/useMobileWorkspace'
import { BRAND_WORDMARK, brandNeedsWordmark, useTranslation } from '../i18n'
import { isInFloatingLayer } from '../lib/dropdown'
import {
  PrivateWebHeaderAccountActions,
  PrivateWebHeaderCreditAction,
  PrivateWebReplacesAuthActions,
} from '../lib/privateOverlay'
import { useSyncStatus } from '../lib/sync/status'
import { isWorkbenchMode, useStore } from '../store'
import BrandAvatar from './BrandAvatar'
import DisplaySettingsMenuItems from './DisplaySettingsMenuItems'
import GuestAccountMenu from './GuestAccountMenu'
import HeaderMembershipChip from './HeaderMembershipChip'
import LocaleGlobe from './LocaleGlobe'
import LogoutDialog from './LogoutDialog'
import { Button } from './ui/button'
import { Icon } from './ui/icon'

export default function Header() {
  const { t } = useTranslation('shell')
  useWorkspaceViewport()
  const setShowSettings = useStore((s) => s.setShowSettings)
  const appMode = useStore((s) => s.appMode)
  const workbench = isWorkbenchMode(appMode)
  const [loggingOut, setLoggingOut] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [loginMethodsOpen, setLoginMethodsOpen] = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)
  const headerActionsRef = useRef<HTMLDivElement>(null)
  const auth = useAuth()

  const syncPending = useSyncStatus((s) => s.enabled && (s.pending > 0 || s.status === 'error'))

  useLayoutEffect(() => {
    const node = headerActionsRef.current
    if (!node) return
    const updateWidth = () => {
      document.documentElement.style.setProperty(
        '--studio-header-actions-width',
        `${Math.ceil(node.getBoundingClientRect().width)}px`,
      )
    }
    updateWidth()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateWidth)
    observer?.observe(node)
    return () => {
      observer?.disconnect()
      document.documentElement.style.removeProperty('--studio-header-actions-width')
    }
  }, [])
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
      if (isInFloatingLayer(event.target)) return
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
    setAccountMenuOpen(false)
    setShowSettings(true)
  }

  return (
    <>
      {/*
        窄屏有一条深色顶栏，圆角内容面板从它下面留出缝。宽屏没有这条栏，
        账号簇浮在内容面板右上角，页头按测得的宽度让出右侧空位。
      */}
      <div
        aria-hidden
        className="studio-mobile-topbar pointer-events-none fixed inset-x-0 top-0 z-30 bg-sidebar md:hidden"
        style={{ height: 'var(--mobile-topbar-height)' }}
      />
      <div
        ref={headerActionsRef}
        data-no-drag-select
        className="studio-global-account fixed z-40 flex items-center gap-3"
        style={{
          top: 'calc(var(--safe-area-top) + var(--studio-account-cluster-top) + var(--app-header-inset))',
          right: 'calc(12px + var(--app-header-inset))',
        }}
      >
        {workbench && agentPanelPresent() ? <AgentJobInbox /> : null}
        <div className="studio-header-float flex items-center gap-2">
          {auth.user ? <PrivateWebHeaderCreditAction /> : null}
          {auth.user ? <HeaderMembershipChip /> : null}
          <LocaleGlobe />
          {auth.user ? (
            <PrivateWebHeaderAccountActions
              username={auth.user.username}
              loggingOut={loggingOut}
              syncPending={syncPending}
              onOpenSettings={openSettings}
              onLogout={() => setLogoutOpen(true)}
            />
          ) : null}
          {/* 访客也要能切主题与语言；登录后若私有 overlay 接管了账号簇，这份菜单让位。 */}
          {!auth.user || !PrivateWebReplacesAuthActions ? (
            <div ref={accountMenuRef} className="relative">
              <Button
                type="button"
                onClick={() => setAccountMenuOpen((open) => !open)}
                aria-label={auth.user ? t('header.accountMenu') : t('header.appMenu')}
                aria-haspopup="menu"
                aria-expanded={accountMenuOpen}
                size="icon-lg"
                variant={auth.user ? 'default' : 'ghost'}
                className="relative rounded-full text-muted-foreground"
              >
                {auth.user ? (
                  <BrandAvatar />
                ) : (
                  <Icon name="user" className="size-6 text-muted-foreground" />
                )}
                {syncPending ? (
                  <span
                    role="img"
                    aria-label={t('header.unsynced')}
                    className="absolute right-0 top-0 h-2 w-2 rounded-full bg-warning ring-2 ring-white dark:ring-border"
                  />
                ) : null}
              </Button>
              {accountMenuOpen && !auth.user ? (
                <GuestAccountMenu
                  authEnabled={auth.enabled}
                  onLogin={() => {
                    setAccountMenuOpen(false)
                    auth.login()
                  }}
                  onClose={() => setAccountMenuOpen(false)}
                />
              ) : null}
              {accountMenuOpen && auth.user ? (
                <div
                  role="menu"
                  className="absolute right-0 top-[calc(100%+0.75rem)] z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-1.5 text-sm shadow-popover"
                >
                  <div className="truncate px-3 py-2 font-medium text-foreground">
                    {auth.user?.username ??
                      `${t('header.brandName')}${brandNeedsWordmark() ? ` ${BRAND_WORDMARK}` : ''}`}
                  </div>
                  <DisplaySettingsMenuItems
                    itemClassName="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-muted"
                    iconClassName="size-4"
                  />
                  <Button
                    type="button"
                    role="menuitem"
                    onClick={openSettings}
                    variant="ghost"
                    className="w-full justify-start text-muted-foreground"
                  >
                    <Icon name="settings" />
                    <span>{t('header.settings')}</span>
                    {syncPending ? (
                      <span
                        role="img"
                        aria-label={t('header.unsynced')}
                        className="ml-auto h-1.5 w-1.5 rounded-full bg-warning"
                      />
                    ) : null}
                  </Button>
                  {auth.enabled && auth.user ? (
                    <>
                      <Button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setAccountMenuOpen(false)
                          setLoginMethodsOpen(true)
                        }}
                        variant="ghost"
                        className="w-full justify-start text-muted-foreground"
                      >
                        {t('header.loginMethods')}
                      </Button>
                      <Button
                        type="button"
                        role="menuitem"
                        disabled={loggingOut}
                        onClick={() => {
                          setAccountMenuOpen(false)
                          setLogoutOpen(true)
                        }}
                        variant="ghost"
                        className="w-full justify-start text-muted-foreground disabled:cursor-wait"
                      >
                        {loggingOut ? t('header.loggingOut') : t('logout.title')}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {/* 未登录访客的入口。放在最右：它是这一簇里唯一一个「现在该点」的按钮。 */}
          {auth.enabled && !auth.user ? (
            <Button type="button" onClick={auth.login} size="sm">
              {t('header.login')}
            </Button>
          ) : null}
        </div>
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
