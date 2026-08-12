import { type FormEvent, useState } from 'react'
import { AuthRequestError, loginUser, registerUser } from '../lib/authClient'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { type RegistrationCredentials, RegistrationPanel } from './RegistrationPanel'

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
      {crossed ? <path d="m4 4 16 16" /> : null}
    </svg>
  )
}

function ProviderMark({ provider }: { provider: 'google' | 'facebook' | 'apple' | 'microsoft' }) {
  if (provider === 'google') return <span className="auth-provider-google">G</span>
  if (provider === 'facebook') return <span className="auth-provider-facebook">f</span>
  if (provider === 'apple') {
    return (
      <svg
        className="auth-provider-apple"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M16.8 12.8c0-2.5 2.1-3.7 2.2-3.8a4.8 4.8 0 0 0-3.8-2c-1.6-.2-3.1 1-3.9 1s-2-1-3.4-1c-1.7 0-3.4 1-4.3 2.6-1.9 3.2-.5 8 1.3 10.5.9 1.2 1.9 2.6 3.3 2.5 1.3-.1 1.8-.8 3.5-.8 1.6 0 2.1.8 3.5.8 1.5 0 2.4-1.3 3.2-2.6a10.8 10.8 0 0 0 1.5-3.1c-.1 0-3.1-1.2-3.1-4.1ZM14.2 5.3A4.6 4.6 0 0 0 15.3 2a4.8 4.8 0 0 0-3.1 1.6A4.3 4.3 0 0 0 11 6.8a4 4 0 0 0 3.2-1.5Z" />
      </svg>
    )
  }
  return (
    <span className="auth-provider-microsoft" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_credentials') return '账号或密码不正确'
    if (error.code === 'rate_limited') return '尝试次数过多，请稍后再试'
  }
  return '暂时无法登录，请检查网络后重试'
}

function registrationErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'username_taken') return '该用户名已被使用'
    if (error.code === 'invalid_username') return '用户名格式不正确'
    if (error.code === 'invalid_password') return '密码格式不正确'
    if (error.code === 'rate_limited') return '注册尝试过于频繁，请稍后再试'
  }
  return '暂时无法创建账户，请检查网络后重试'
}

export function LoginScreen() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<'login' | 'registration'>('login')
  const registrationEnabled = isClientCapabilityEnabled('accounts:self-register')

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!username.trim() || !password || pending) return
    setPending(true)
    setError(null)
    try {
      await loginUser(username, password)
      // 重新启动模块，确保 Zustand/IndexedDB 从当前账号的隔离 namespace 初始化。
      window.location.reload()
    } catch (err) {
      setError(errorMessage(err))
      setPending(false)
    }
  }

  async function submitRegistration(credentials: RegistrationCredentials): Promise<void> {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      await registerUser(credentials.username, credentials.password)
      // 注册响应已写入 session cookie。重启模块以初始化当前账户的隔离 namespace。
      window.location.reload()
    } catch (err) {
      setError(registrationErrorMessage(err))
      setPending(false)
    }
  }

  return (
    <main className={`auth-shell${view === 'registration' ? ' auth-shell--registration' : ''}`}>
      <div className="auth-photo" aria-hidden="true" />
      <div className="auth-vignette" aria-hidden="true" />

      <header className="auth-brand">
        <img src="./pwa-icon.svg" alt="" width="36" height="36" />
        <span>Image Playground</span>
      </header>

      <section className="auth-entry">
        {view === 'registration' ? (
          <div className="auth-card auth-card--registration">
            <RegistrationPanel
              pending={pending}
              error={error}
              onBack={() => {
                setError(null)
                setView('login')
              }}
              onRegister={(credentials) => void submitRegistration(credentials)}
            />
          </div>
        ) : (
          <form
            className="auth-card"
            onSubmit={(event) => void submit(event)}
            aria-label="用户登录"
          >
            <div className="auth-card-heading">
              <h1>欢迎使用 Image Playground</h1>
              <p>登录后，开启你的灵感创作。</p>
            </div>

            <label className="auth-field">
              <span>用户名</span>
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.currentTarget.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                disabled={pending}
                placeholder="请输入用户名"
              />
            </label>

            <label className="auth-field">
              <span>密码</span>
              <div className="auth-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  autoComplete="current-password"
                  disabled={pending}
                  placeholder="请输入密码"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                >
                  <EyeIcon crossed={showPassword} />
                </button>
              </div>
            </label>

            <div className="auth-password-help">
              <span>忘记密码？</span>
            </div>
            <div className="auth-message-slot" aria-live="polite">
              {error ? (
                <p role="alert" className="auth-error">
                  {error}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="auth-submit"
              disabled={pending || !username.trim() || !password}
            >
              {pending ? (
                <>
                  <i className="auth-spinner" aria-hidden="true" />
                  正在登录
                </>
              ) : (
                '登录'
              )}
            </button>

            <div className="auth-divider">
              <span>其他登录方式</span>
            </div>
            <div className="auth-providers" aria-label="其他登录方式暂未开放">
              {(['google', 'facebook', 'apple', 'microsoft'] as const).map((provider) => (
                <button
                  key={provider}
                  type="button"
                  disabled
                  aria-label={`${provider} 登录暂未开放`}
                >
                  <ProviderMark provider={provider} />
                </button>
              ))}
            </div>
            <p className="auth-signup">
              还没有账户？
              {registrationEnabled ? (
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setView('registration')
                  }}
                >
                  注册账户
                </button>
              ) : (
                <span>注册暂未开放</span>
              )}
            </p>
          </form>
        )}
      </section>

      <footer className="auth-footer">
        <div>
          <img src="./pwa-icon.svg" alt="" width="24" height="24" />
          <strong>Image Playground</strong>
        </div>
        <p>版权所有 © 2026</p>
      </footer>
    </main>
  )
}
