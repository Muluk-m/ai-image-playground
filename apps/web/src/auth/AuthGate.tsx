import type { AuthUserView } from '@image-playground/shared'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { signalBootReady } from '../boot/ready'
import { Button } from '../components/ui/button'
import { Icon } from '../components/ui/icon'
import PricingSheet from '../features/pricing/PricingSheet'
import { useTranslation } from '../i18n'
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AuthRequestError,
  clearOAuthSessionLanding,
  getCurrentUser,
  logoutUser,
  noteBrowserSession,
  shouldProbeSession,
} from '../lib/authClient'
import { setClientStorageScope, setRecoveryBackend } from '../lib/authScope'
import { bootstrapChannels } from '../lib/channels/bootstrapChannels'
import { clearScopedClientStorage } from '../lib/clearScopedStorage'
import { applySessionCapabilityGrants, isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { recoverStorageUser } from '../lib/localRecovery'
import { getRuntimeConfig } from '../lib/runtimeConfig'
import { adoptAnonymousStorage } from '../lib/storageAdoption'
import { AuthContextProvider } from './AuthContext'
import { LoginDialog } from './LoginDialog'
import { type LoginPromptReason, setSignedIn, subscribeLoginPrompt } from './loginPrompt'
import { discardPendingSubmission, hasPendingSubmission } from './pendingSubmission'
import { SessionExpiredCard } from './SessionExpiredCard'

const App = lazy(() => import('../App'))

type Phase = 'checking' | 'ready' | 'reconnecting'

/**
 * `login=1` is a one-shot intent used by entry points that cannot open the
 * dialog themselves (a fresh page or a logout reload). Do not consume it until
 * the session probe has settled: a signed-in user must never see a login
 * dialog, and an unresolved probe must not make the marketing/workspace
 * boundary visible.
 */
function consumeLoginIntent(open?: () => void): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (url.searchParams.get('login') !== '1') return
  url.searchParams.delete('login')
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  open?.()
}

export function LoadingScreen() {
  const { t } = useTranslation('auth')
  return (
    <p className="sr-only" aria-live="polite">
      {t('status.preparing')}
    </p>
  )
}

export function ProblemScreen({
  title,
  description,
  retry,
}: {
  title: string
  description: string
  retry?: () => void
}) {
  const { t } = useTranslation('auth')
  useEffect(() => {
    signalBootReady()
  }, [])
  return (
    <main className="auth-status-screen auth-status-screen--problem">
      <section
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-left"
        aria-live="polite"
      >
        <div className="auth-recovery-icon" aria-hidden="true">
          <Icon name="error" size="md" />
        </div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-body-sm text-muted-foreground">{description}</p>
        {retry ? (
          <Button type="button" variant="secondary" className="mt-6" onClick={retry}>
            <Icon name="refresh" />
            {t('status.retry')}
          </Button>
        ) : null}
      </section>
    </main>
  )
}

export function AuthGate() {
  const { t } = useTranslation('auth')
  const runtime = getRuntimeConfig()
  const accountsLoginEnabled = isClientCapabilityEnabled('accounts:login')
  const localRecoveryEnabled = isClientCapabilityEnabled('accounts:local-recovery')
  const [phase, setPhase] = useState<Phase>('checking')
  const [user, setUser] = useState<AuthUserView | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [adoptedTaskCount, setAdoptedTaskCount] = useState(0)
  const [loginReason, setLoginReason] = useState<LoginPromptReason | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    let cancelled = false
    let retryTimer: number | undefined
    const abortController = new AbortController()
    async function boot(): Promise<void> {
      try {
        setRecoveryBackend(
          !accountsLoginEnabled && localRecoveryEnabled ? runtime.bff.baseUrl : null,
        )
        if (!accountsLoginEnabled) {
          const id = localRecoveryEnabled ? await recoverStorageUser() : null
          if (cancelled) return
          setClientStorageScope(id)
          setPhase('ready')
          consumeLoginIntent()
          return
        }
        // 没有会话不是错误：访客照样进工作台，按下需要账号的动作时再弹登录框。
        // 没有页面上的提示 cookie、记住的用户，也不是 OAuth 刚回来时，不请求 /api/auth/me。
        const probeSession = shouldProbeSession()
        const currentUser = probeSession
          ? await getCurrentUser(AbortSignal.timeout(15000)).catch((err) => {
              if (err instanceof AuthRequestError && err.status === 401) return null
              throw err
            })
          : null
        if (cancelled) return
        if (probeSession) clearOAuthSessionLanding()
        setSignedIn(Boolean(currentUser))
        setClientStorageScope(currentUser?.id ?? null)
        if (!currentUser) {
          // 匿名可读：channel 清单只列出这个部署提供哪些模型，不含任何凭据。
          await bootstrapChannels(
            runtime.bff.enabled,
            runtime.bff.baseUrl,
            true,
            abortController.signal,
          )
          const pendingSend = await hasPendingSubmission().catch(() => false)
          if (cancelled) return
          if (pendingSend) setLoginReason('gated-action')
          noteBrowserSession(null)
          applySessionCapabilityGrants(null)
          setUser(null)
          setPhase('ready')
          consumeLoginIntent(() => setLoginReason('gated-action'))
          return
        }
        const [adopted] = await Promise.all([
          // 必须跑在 <App/> 之前：store 是 lazy 加载的，一旦求值就读走 IndexedDB 与 persist key。
          adoptAnonymousStorage(),
          // 登录用户这条必须成真：session 若恰好在两次请求之间过期，宁可停在错误页，
          // 也不能把 stale user 标成 ready 后再满屏 401。
          bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl, true, abortController.signal),
        ])
        if (!cancelled) {
          setAdoptedTaskCount(adopted)
          noteBrowserSession(currentUser.id)
          setUser(currentUser)
          setPhase('ready')
          consumeLoginIntent()
        }
      } catch {
        if (cancelled) return
        // A slow channel request or a brief BFF interruption should recover on its own.
        // Keep the initial loading state through the first retry to avoid flashing an error.
        if (attempt > 0) setPhase('reconnecting')
        retryTimer = window.setTimeout(
          () => setAttempt((value) => value + 1),
          Math.min(1000 * 2 ** attempt, 15000),
        )
      }
    }
    void boot()
    return () => {
      cancelled = true
      abortController.abort()
      window.clearTimeout(retryTimer)
    }
  }, [
    accountsLoginEnabled,
    localRecoveryEnabled,
    attempt,
    runtime.bff.baseUrl,
    runtime.bff.enabled,
  ])

  useEffect(() => {
    if (!accountsLoginEnabled) return
    const expired = () => {
      noteBrowserSession(null)
      applySessionCapabilityGrants(null)
      setSignedIn(false)
      setUser(null)
      setSessionExpired(true)
    }
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  }, [accountsLoginEnabled])

  useEffect(() => subscribeLoginPrompt(setLoginReason), [])

  const logout = useCallback(async (clearLocalData: boolean) => {
    let signedOut = false
    try {
      await logoutUser()
      signedOut = true
      if (clearLocalData) await clearScopedClientStorage()
    } finally {
      // Keep the existing session hint when the API rejected logout: reloading
      // must probe the server session rather than silently presenting a guest UI.
      if (signedOut) {
        noteBrowserSession(null)
        // A reload is required here because several account-scoped stores are
        // module singletons. Keep the exact workspace URL while asking the next
        // boot to open the dialog; this prevents the old account's in-memory
        // state from surviving an account switch.
        const url = new URL(window.location.href)
        url.searchParams.set('login', '1')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      }
      window.location.reload()
    }
  }, [])

  if (phase === 'checking') return <LoadingScreen />
  if (phase === 'reconnecting') {
    return (
      <ProblemScreen
        title={t('status.unavailableTitle')}
        description={t('status.unavailableDescription')}
        retry={() => {
          setAttempt((value) => value + 1)
        }}
      />
    )
  }

  return (
    <AuthContextProvider
      value={{
        enabled: accountsLoginEnabled,
        user,
        login: () => setLoginReason(sessionExpired ? 'session-expired' : 'gated-action'),
        logout,
      }}
    >
      <Suspense fallback={<LoadingScreen />}>
        <App adoptedTaskCount={adoptedTaskCount} />
      </Suspense>
      {sessionExpired && loginReason === null ? (
        <SessionExpiredCard
          onRelogin={() => setLoginReason('session-expired')}
          onDismiss={() => setSessionExpired(false)}
        />
      ) : null}
      {loginReason ? (
        <LoginDialog
          reason={loginReason}
          onClose={() => {
            setLoginReason(null)
            void discardPendingSubmission()
          }}
        />
      ) : null}
      <PricingSheet />
    </AuthContextProvider>
  )
}
