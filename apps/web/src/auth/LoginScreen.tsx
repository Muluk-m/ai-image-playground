import { type FormEvent, useState } from 'react'
import { AuthRequestError, loginUser, registerUser } from '../lib/authClient'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { type RegistrationCredentials, RegistrationPanel } from './RegistrationPanel'

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed ? <path d="m4 4 16 16" /> : null}
    </svg>
  )
}

function ProviderMark({ provider }: { provider: 'google' | 'github' | 'discord' }) {
  if (provider === 'google') return <span className="auth-provider-google">G</span>
  if (provider === 'github') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2C6.48 2 2 6.58 2 12.23c0 4.52 2.87 8.35 6.84 9.71.5.1.68-.22.68-.49v-1.91c-2.78.62-3.37-1.21-3.37-1.21-.45-1.19-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.64-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.94a9.3 9.3 0 0 1 2.5.35c1.91-1.33 2.75-1.05 2.75-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9v2.79c0 .27.18.59.69.49A10.24 10.24 0 0 0 22 12.23C22 6.58 17.52 2 12 2Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M19.5 5.34A17.6 17.6 0 0 0 15.2 4l-.53 1.08a15.7 15.7 0 0 0-5.31 0L8.8 4a17.7 17.7 0 0 0-4.3 1.34C1.78 9.43 1.04 13.42 1.4 17.35a17.2 17.2 0 0 0 5.28 2.68l1.28-1.76a10.8 10.8 0 0 1-2.01-.98l.5-.39c3.88 1.82 8.1 1.82 11.94 0l.51.39c-.64.39-1.32.72-2.02.98l1.28 1.76a17.2 17.2 0 0 0 5.28-2.68c.42-4.56-.72-8.51-3.94-12.01ZM8.67 14.93c-1.17 0-2.12-1.1-2.12-2.45s.93-2.45 2.12-2.45 2.14 1.11 2.12 2.45c0 1.35-.93 2.45-2.12 2.45Zm6.66 0c-1.17 0-2.12-1.1-2.12-2.45s.93-2.45 2.12-2.45 2.14 1.11 2.12 2.45c0 1.35-.93 2.45-2.12 2.45Z" />
    </svg>
  )
}

function FeatureIcon({ kind }: { kind: 'model' | 'speed' | 'security' }) {
  if (kind === 'model') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8L12 3Z" />
        <path d="m18.5 14 .6 2.1 1.9.9-1.9.9-.6 2.1-.6-2.1L16 17l1.9-.9.6-2.1Z" />
      </svg>
    )
  }
  if (kind === 'speed') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <path d="m13.5 2-8 11h6L10.5 22l8-12h-6l1-8Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 3 5 6v5c0 4.6 2.7 8.1 7 10 4.3-1.9 7-5.4 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

function AuthShowcase() {
  return (
    <section className="auth-showcase">
      <header className="auth-brand">
        <img src="/pwa-icon.svg" alt="" width="30" height="30" />
        <span>Image Playground</span>
      </header>

      <div className="auth-art-wall" aria-hidden>
        <img
          className="auth-art auth-art--portrait"
          src="https://cms-r2.deepclick.com/image-playground/case427.jpg?w=560&q=86"
          alt=""
        />
        <img
          className="auth-art auth-art--anime"
          src="https://cms-r2.deepclick.com/image-playground/case410.jpg?w=560&q=86"
          alt=""
        />
        <img
          className="auth-art auth-art--landscape"
          src="https://cms-r2.deepclick.com/image-playground/case304.jpg?w=560&q=86"
          alt=""
        />
        <img
          className="auth-art auth-art--pet"
          src="https://cms-r2.deepclick.com/image-playground-banana/19770.jpg?w=560&q=86"
          alt=""
        />
        <img
          className="auth-art auth-art--car"
          src="https://cms-r2.deepclick.com/image-playground-banana/13399.jpg?w=560&q=86"
          alt=""
        />
      </div>

      <div className="auth-showcase-copy">
        <h2>
          释放创意，
          <br />
          让想象成真
        </h2>
        <p>使用先进的 AI 技术，将文字和灵感转化为精美的图像作品。</p>
      </div>

      <div className="auth-benefits">
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="model" />
          </span>
          <strong>强大模型</strong>
          <p>
            前沿 AI 模型
            <br />
            生成高质量图像
          </p>
        </div>
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="speed" />
          </span>
          <strong>快速生成</strong>
          <p>
            秒级出图
            <br />
            高效实现创意
          </p>
        </div>
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="security" />
          </span>
          <strong>安全可靠</strong>
          <p>
            隐私保护
            <br />
            你的数据安全无忧
          </p>
        </div>
      </div>
    </section>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_credentials') return '邮箱地址或密码不正确'
    if (error.code === 'rate_limited') return '尝试次数过多，请稍后再试'
  }
  return '暂时无法登录，请检查网络后重试'
}

function registrationErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'username_taken') return '该邮箱地址已注册'
    if (error.code === 'invalid_username') return '邮箱地址格式不正确'
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
      window.location.reload()
    } catch (err) {
      setError(registrationErrorMessage(err))
      setPending(false)
    }
  }

  return (
    <main className={`auth-shell${view === 'registration' ? ' auth-shell--registration' : ''}`}>
      <div className="auth-frame">
        <AuthShowcase />

        <section className="auth-panel">
          <label className="auth-language">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21c-2.2-2.5-3.3-5.5-3.3-9S9.8 5.5 12 3Z" />
            </svg>
            <select aria-label="界面语言" value="zh-CN" disabled>
              <option value="zh-CN">中文</option>
            </select>
          </label>

          <div className="auth-panel-content">
            {view === 'registration' ? (
              <RegistrationPanel
                pending={pending}
                error={error}
                onBack={() => {
                  setError(null)
                  setView('login')
                }}
                onRegister={(credentials) => void submitRegistration(credentials)}
              />
            ) : (
              <div className="auth-form-view auth-login">
                <div className="auth-form-heading">
                  <h1>欢迎回来</h1>
                  <p>登录你的账户，继续创作</p>
                </div>

                <div className="auth-providers" aria-label="第三方登录暂未开放">
                  {(['google', 'github', 'discord'] as const).map((provider) => (
                    <button
                      key={provider}
                      type="button"
                      disabled
                      aria-label={`${provider} 登录暂未开放`}
                    >
                      <ProviderMark provider={provider} />
                      <span>
                        {provider === 'google'
                          ? 'Google'
                          : provider === 'github'
                            ? 'GitHub'
                            : 'Discord'}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="auth-divider">
                  <span>或使用邮箱登录</span>
                </div>

                <form
                  className="auth-form"
                  onSubmit={(event) => void submit(event)}
                  aria-label="用户登录"
                >
                  <label className="auth-field">
                    <span>邮箱地址</span>
                    <input
                      name="username"
                      type="text"
                      inputMode="email"
                      value={username}
                      onChange={(event) => setUsername(event.currentTarget.value)}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      autoFocus
                      disabled={pending}
                      placeholder="请输入您的邮箱地址"
                    />
                  </label>

                  <label className="auth-field">
                    <span>密码</span>
                    <div className="auth-password">
                      <input
                        name="password"
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
                        disabled={pending}
                        aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      >
                        <EyeIcon crossed={showPassword} />
                      </button>
                    </div>
                  </label>

                  <div className="auth-login-options">
                    <label title="登录状态默认安全保留 30 天">
                      <input type="checkbox" disabled />
                      <span>记住我</span>
                    </label>
                    <span className="auth-forgot" title="暂未开放">
                      忘记密码？
                    </span>
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
                        <i className="auth-spinner" aria-hidden />
                        正在登录
                      </>
                    ) : (
                      '登录'
                    )}
                  </button>
                </form>

                <p className="auth-switch">
                  还没有账户？
                  {registrationEnabled ? (
                    <button
                      type="button"
                      onClick={() => {
                        setError(null)
                        setView('registration')
                      }}
                    >
                      立即注册
                    </button>
                  ) : (
                    <span>注册暂未开放</span>
                  )}
                </p>
                <p className="auth-terms">登录即表示你同意我们的服务条款和隐私政策</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
