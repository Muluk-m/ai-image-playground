import type { AuthUserView } from '@image-playground/shared'
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import {
  AUTH_SESSION_EXPIRED_EVENT,
  AuthRequestError,
  getCurrentUser,
  logoutUser,
} from '../lib/authClient'
import { setClientStorageScope } from '../lib/authScope'
import { bootstrapChannels } from '../lib/channels/bootstrapChannels'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { getRuntimeConfig } from '../lib/runtimeConfig'
import { adoptAnonymousStorage } from '../lib/storageAdoption'
import { AuthContextProvider } from './AuthContext'
import { LoginScreen } from './LoginScreen'

const App = lazy(() => import('../App'))

type Phase = 'checking' | 'ready' | 'login' | 'unavailable'

function LoadingScreen() {
  return (
    <main className="auth-status-screen" aria-live="polite">
      <img src="/pwa-icon.svg" alt="" width="40" height="40" />
      <div className="auth-status-line">
        <span />
      </div>
      <p>正在准备工作台</p>
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
  return (
    <main className="auth-status-screen">
      <div className="auth-problem-mark">!</div>
      <h1>{title}</h1>
      <p>{description}</p>
      {retry ? (
        <button type="button" onClick={retry}>
          重新连接
        </button>
      ) : null}
    </main>
  )
}

export function AuthGate() {
  const runtime = getRuntimeConfig()
  const accountsLoginEnabled = isClientCapabilityEnabled('accounts:login')
  const [phase, setPhase] = useState<Phase>('checking')
  const [user, setUser] = useState<AuthUserView | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function boot(): Promise<void> {
      if (!accountsLoginEnabled) {
        setClientStorageScope(null)
        if (!cancelled) setPhase('ready')
        return
      }

      try {
        const currentUser = await getCurrentUser()
        setClientStorageScope(currentUser.id)
        // 必须在 <App/> 之前 await：store 是 lazy 加载的，一旦求值就读走
        // IndexedDB 与 persist key，之后再搬历史就晚了。
        await adoptAnonymousStorage()
        // 认证部署中 channel discovery 同样是受保护请求。这里不能静默降级：
        // session 若恰好过期，应停在登录页，不能把 stale user 标成 ready。
        await bootstrapChannels(runtime.bff.enabled, runtime.bff.baseUrl, true)
        if (!cancelled) {
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
  }, [accountsLoginEnabled, attempt, runtime.bff.baseUrl, runtime.bff.enabled])

  useEffect(() => {
    const expired = () => {
      setUser(null)
      setPhase('login')
    }
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    return () => window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutUser()
    } finally {
      window.location.reload()
    }
  }, [])

  if (phase === 'checking') return <LoadingScreen />
  if (phase === 'login') return <LoginScreen />
  if (phase === 'unavailable') {
    return (
      <ProblemScreen
        title="暂时无法连接服务"
        description="工作台没有进入匿名模式。请确认服务运行正常后重试。"
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
        <App />
      </Suspense>
    </AuthContextProvider>
  )
}
