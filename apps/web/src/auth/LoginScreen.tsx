import { type FormEvent, useState } from 'react'
import { AuthRequestError, loginUser } from '../lib/authClient'

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
      {crossed ? <path d="m4 4 16 16" /> : null}
    </svg>
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
      <div className="auth-grid" aria-hidden="true" />
      <div className="auth-orbit auth-orbit-a" aria-hidden="true" />
      <div className="auth-orbit auth-orbit-b" aria-hidden="true" />

      <section className="auth-story">
        <div className="auth-brand">
          <img src="./pwa-icon.svg" alt="" width="32" height="32" />
          <span>Image Playground</span>
        </div>
        <div className="auth-story-copy">
          <p className="auth-kicker">PRIVATE GENERATIVE STUDIO</p>
          <h1>
            想法进入这里，
            <br />
            以画面离开。
          </h1>
          <p className="auth-intro">
            一个专注的图像创作空间。你的任务、素材与工作参数只留在当前账号的本地工作区。
          </p>
        </div>
        <div className="auth-proof" aria-hidden="true">
          <span>01</span>
          <div />
          <p>Prompt</p>
          <span>02</span>
          <div />
          <p>Compose</p>
          <span>03</span>
          <div />
          <p>Generate</p>
        </div>
      </section>

      <section className="auth-entry">
        <form className="auth-card" onSubmit={(event) => void submit(event)} aria-label="用户登录">
          <div>
            <p className="auth-card-index">ACCESS / 01</p>
            <h2>进入工作台</h2>
            <p className="auth-card-subtitle">使用管理员分配给你的账号登录</p>
          </div>

          <label className="auth-field">
            <span>账号</span>
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              disabled={pending}
              placeholder="username"
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
                placeholder="••••••••"
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

          <div className="auth-message-slot">
            {error ? (
              <p role="alert" className="auth-error">
                <span aria-hidden="true">!</span>
                {error}
              </p>
            ) : (
              <p>账号由管理员创建，不支持公开注册</p>
            )}
          </div>

          <button
            type="submit"
            className="auth-submit"
            disabled={pending || !username.trim() || !password}
          >
            <span>{pending ? '正在验证' : '登录'}</span>
            {pending ? (
              <i className="auth-spinner" aria-hidden="true" />
            ) : (
              <b aria-hidden="true">↗</b>
            )}
          </button>
        </form>
      </section>
    </main>
  )
}
