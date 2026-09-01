import { OAUTH_ERROR_QUERY_PARAM, type OAuthProviderView } from '@image-playground/shared'
import { type FormEvent, useEffect, useState } from 'react'
import {
  AuthRequestError,
  fetchOAuthProviders,
  loginUser,
  oauthStartUrl,
  registerUser,
} from '../lib/authClient'
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

function ProviderMark({ provider }: { provider: OAuthProviderView }) {
  if (provider.id === 'google') return <span className="auth-provider-google">G</span>
  return <span className="auth-provider-generic">{provider.label.slice(0, 1)}</span>
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

function oauthErrorMessage(code: string): string {
  if (code === 'registration_closed') return '注册暂未开放，请联系管理员开通账户'
  if (code === 'account_disabled') return '该账户已被停用'
  if (code === 'access_denied') return '你取消了第三方授权'
  return '第三方登录失败，请重试或改用邮箱登录'
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
  const [providers, setProviders] = useState<OAuthProviderView[]>([])
  const registrationEnabled = isClientCapabilityEnabled('accounts:self-register')

  useEffect(() => {
    let cancelled = false
    void fetchOAuthProviders().then((available) => {
      if (!cancelled) setProviders(available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    const code = url.searchParams.get(OAUTH_ERROR_QUERY_PARAM)
    if (!code) return
    setError(oauthErrorMessage(code))
    // Strip the parameter so a reload does not resurface a failure the user already saw.
    url.searchParams.delete(OAUTH_ERROR_QUERY_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

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

                {providers.length > 0 ? (
                  <>
                    <div className="auth-providers">
                      {providers.map((provider) => (
                        <button
                          key={provider.id}
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            window.location.href = oauthStartUrl(provider.id)
                          }}
                        >
                          <ProviderMark provider={provider} />
                          <span>{provider.label}</span>
                        </button>
                      ))}
                    </div>

                    <div className="auth-divider">
                      <span>或使用邮箱登录</span>
                    </div>
                  </>
                ) : null}

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
