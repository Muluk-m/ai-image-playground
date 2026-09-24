import type { AuthUserView } from '@image-playground/shared'
import { RefreshCw, WifiOff } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { adoptAgentConversations } from '../features/agent/lib/agentClient'
import { useTranslation } from '../i18n'
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AuthRequestError,
  getCurrentUser,
  logoutUser,
} from '../lib/authClient'
import { setClientStorageScope, setRecoveryBackend } from '../lib/authScope'
import { bootstrapChannels } from '../lib/channels/bootstrapChannels'
import { clearScopedClientStorage } from '../lib/clearScopedStorage'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { recoverStorageUser, rememberStorageUser } from '../lib/localRecovery'
import { getRuntimeConfig } from '../lib/runtimeConfig'
import { adoptAnonymousStorage } from '../lib/storageAdoption'
import { AuthContextProvider } from './AuthContext'
import { LoginDialog } from './LoginDialog'
import { type LoginPromptReason, setSignedIn, subscribeLoginPrompt } from './loginPrompt'
import { discardPendingSubmission, hasPendingSubmission } from './pendingSubmission'
import { SessionExpiredCard } from './SessionExpiredCard'

const App = lazy(() => import('../App'))

type Phase = 'checking' | 'ready' | 'reconnecting'

function LoadingScreen() {
  const { t } = useTranslation('auth')
  return (
    <main className="auth-status-screen" aria-live="polite">
      <img src="/brand/muvloom-mark.svg" alt="" width="40" height="40" />
      <div className="auth-status-line">
        <span />
      </div>
      <p>{t('status.preparing')}</p>
    </main>
  )
}

function ProblemScreen({
  title,
  description,
  retry,
}: {
  title: string
  description: string
  retry?: () => void
}) {
  const { t } = useTranslation('auth')
  return (
    <main className="auth-status-screen auth-status-screen--problem">
      <section className="auth-recovery-card" aria-live="polite">
        <div className="auth-recovery-icon" aria-hidden="true">
          <WifiOff size={19} strokeWidth={1.8} />
        </div>
        <h1>{title}</h1>
        <p>{description}</p>
        {retry ? (
          <button type="button" onClick={retry}>
            <RefreshCw size={15} strokeWidth={2} aria-hidden="true" />
            {t('status.retry')}
          </button>
        ) : null}
      </section>
    </main>
  )
}

/** 会话存在服务端，本地那套领养搬不动它，得让 BFF 另外改挂一次。 */
async function adoptDeviceConversations(): Promise<void> {
  if (!isClientCapabilityEnabled('agent:chat')) return
  try {
    await adoptAgentConversations()
  } catch {
    // 搬不成不该把人挡在登录外，下次登录接着搬。
  }
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
          return
        }
        // 没有会话不是错误：访客照样进工作台，按下需要账号的动作时再弹登录框。
        const currentUser = await getCurrentUser(AbortSignal.timeout(15000)).catch((err) => {
          if (err instanceof AuthRequestError && err.status === 401) return null
          throw err
        })
        if (cancelled) return
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
          rememberStorageUser(null)
          setUser(null)
          setPhase('ready')
          return
        }
        const [adopted] = await Promise.all([
          // 必须跑在 <App/> 之前：store 是 lazy 加载的，一旦求值就读走 IndexedDB 与 persist key。
          adoptAnonymousStorage(),
          adoptDeviceConversations(),
          // 登录用户这条必须成真：session 若恰好在两次请求之间过期，宁可停在错误页，
          // 也不能把 stale user 标成 ready 后再满屏 401。
          bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl, true, abortController.signal),
        ])
        if (!cancelled) {
          setAdoptedTaskCount(adopted)
          rememberStorageUser(currentUser.id)
          setUser(currentUser)
          setPhase('ready')
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
      rememberStorageUser(null)
      setSignedIn(false)
      setUser(null)
      setSessionExpired(true)
    }
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  }, [accountsLoginEnabled])

  useEffect(() => subscribeLoginPrompt(setLoginReason), [])

  const logout = useCallback(async (clearLocalData: boolean) => {
    try {
      await logoutUser()
      rememberStorageUser(null)
      if (clearLocalData) await clearScopedClientStorage()
    } finally {
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
    </AuthContextProvider>
  )
}
