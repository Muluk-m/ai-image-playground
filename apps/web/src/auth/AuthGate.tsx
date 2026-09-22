import type { AuthUserView } from '@image-playground/shared'
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
import { LoginScreen } from './LoginScreen'

const App = lazy(() => import('../App'))

type Phase = 'checking' | 'ready' | 'login' | 'unavailable'

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
    <main className="auth-status-screen">
      <div className="auth-problem-mark">!</div>
      <h1>{title}</h1>
      <p>{description}</p>
      {retry ? (
        <button type="button" onClick={retry}>
          {t('status.retry')}
        </button>
      ) : null}
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

  useEffect(() => {
    let cancelled = false
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
        const currentUser = await getCurrentUser()
        setClientStorageScope(currentUser.id)
        const [adopted] = await Promise.all([
          // 必须跑在 <App/> 之前：store 是 lazy 加载的，一旦求值就读走 IndexedDB 与 persist key。
          adoptAnonymousStorage(),
          adoptDeviceConversations(),
          // 认证部署中 channel discovery 同样是受保护请求。这里不能静默降级：
          // session 若恰好过期，应停在登录页，不能把 stale user 标成 ready。
          bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl, true),
        ])
        if (!cancelled) {
          setAdoptedTaskCount(adopted)
          rememberStorageUser(currentUser.id)
          setUser(currentUser)
          setPhase('ready')
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof AuthRequestError && err.status === 401) {
          setPhase('login')
        } else {
          setPhase('unavailable')
        }
      }
    }
    void boot()
    return () => {
      cancelled = true
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
      setUser(null)
      setPhase('login')
    }
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  }, [accountsLoginEnabled])

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
  if (phase === 'login') return <LoginScreen />
  if (phase === 'unavailable') {
    return (
      <ProblemScreen
        title={t('status.unavailableTitle')}
        description={t('status.unavailableDescription')}
        retry={() => {
          setPhase('checking')
          setAttempt((value) => value + 1)
        }}
      />
    )
  }

  return (
    <AuthContextProvider value={{ enabled: accountsLoginEnabled, user, logout }}>
      <Suspense fallback={<LoadingScreen />}>
        <App adoptedTaskCount={adoptedTaskCount} />
      </Suspense>
    </AuthContextProvider>
  )
}
