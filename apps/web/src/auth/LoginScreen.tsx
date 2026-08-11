import { type FormEvent, useState } from 'react'
import { AuthRequestError, loginUser } from '../lib/authClient'

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

export function LoginScreen() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <main className="auth-shell">
      <div className="auth-photo" aria-hidden="true" />
      <div className="auth-vignette" aria-hidden="true" />

      <header className="auth-brand">
        <img src="./pwa-icon.svg" alt="" width="36" height="36" />
        <span>Image Playground</span>
      </header>

      <section className="auth-entry">
        <form className="auth-card" onSubmit={(event) => void submit(event)} aria-label="用户登录">
          <div className="auth-card-heading">
            <h1>Welcome to Image Playground</h1>
            <p>Sign in and start making your dream come true!</p>
          </div>

          <label className="auth-field">
            <span>Username</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              disabled={pending}
              placeholder="Enter your username"
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <div className="auth-password">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                autoComplete="current-password"
                disabled={pending}
                placeholder="Enter your password"
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
            <span>Forgot password?</span>
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
                Signing in
              </>
            ) : (
              'Continue'
            )}
          </button>

          <div className="auth-divider">
            <span>Or continue with</span>
          </div>
          <div className="auth-providers" aria-label="其他登录方式暂未开放">
            {(['google', 'facebook', 'apple', 'microsoft'] as const).map((provider) => (
              <button key={provider} type="button" disabled aria-label={`${provider} 登录暂未开放`}>
                <ProviderMark provider={provider} />
              </button>
            ))}
          </div>
          <p className="auth-signup">
            Don&apos;t have an account? <span>Sign up</span>
          </p>
        </form>
      </section>

      <footer className="auth-footer">
        <div>
          <img src="./pwa-icon.svg" alt="" width="24" height="24" />
          <strong>Image Playground</strong>
        </div>
        <p>Copyright © 2026. All rights reserved.</p>
      </footer>
    </main>
  )
}
