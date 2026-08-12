import {
  isValidPassword,
  isValidUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@image-playground/shared'
import { type FormEvent, useState } from 'react'

export interface RegistrationCredentials {
  username: string
  password: string
}

interface RegistrationPanelProps {
  pending: boolean
  error: string | null
  onBack: () => void
  onRegister: (credentials: RegistrationCredentials) => void
}

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M12 14v2" />
    </svg>
  )
}

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M2.5 12s3.5-5 9.5-5 9.5 5 9.5 5-3.5 5-9.5 5-9.5-5-9.5-5Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed ? <path d="m4 4 16 16" /> : null}
    </svg>
  )
}

export function RegistrationPanel({ pending, error, onBack, onRegister }: RegistrationPanelProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedUsername = username.trim()
    if (!isValidUsername(normalizedUsername)) {
      setValidationError(
        `用户名需为 ${USERNAME_MIN_LENGTH}-${USERNAME_MAX_LENGTH} 位，仅可使用字母、数字、点、下划线和短横线`,
      )
      return
    }
    if (!isValidPassword(password)) {
      setValidationError(`密码需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`)
      return
    }
    if (password !== confirmPassword) {
      setValidationError('两次输入的密码不一致')
      return
    }
    setValidationError(null)
    onRegister({ username: normalizedUsername, password })
  }

  const visibleError = validationError || error

  return (
    <div className="auth-register-panel">
      <button type="button" className="auth-register-back" onClick={onBack} disabled={pending}>
        <span aria-hidden>←</span>
        返回登录
      </button>

      <div className="auth-register-heading">
        <p>创建你的工作台账户</p>
        <h1>注册账户</h1>
        <span>创建账户后，即可登录并开始创作。</span>
      </div>

      <form onSubmit={submit} className="auth-register-form" noValidate>
        <label className="auth-field-label" htmlFor="registration-username">
          用户名
        </label>
        <div className="auth-field-shell">
          <span className="auth-field-icon">
            <UserIcon />
          </span>
          <input
            id="registration-username"
            name="username"
            type="text"
            autoComplete="username"
            minLength={USERNAME_MIN_LENGTH}
            maxLength={USERNAME_MAX_LENGTH}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="请输入用户名"
            disabled={pending}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </div>

        <label className="auth-field-label" htmlFor="registration-password">
          密码
        </label>
        <div className="auth-field-shell">
          <span className="auth-field-icon">
            <LockIcon />
          </span>
          <input
            id="registration-password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入密码"
            disabled={pending}
            required
          />
          <button
            type="button"
            className="auth-password-toggle"
            onClick={() => setShowPassword((value) => !value)}
            disabled={pending}
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
          >
            <EyeIcon crossed={showPassword} />
          </button>
        </div>

        <label className="auth-field-label" htmlFor="registration-confirm-password">
          确认密码
        </label>
        <div className="auth-field-shell">
          <span className="auth-field-icon">
            <LockIcon />
          </span>
          <input
            id="registration-confirm-password"
            name="confirmPassword"
            type={showConfirmation ? 'text' : 'password'}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={PASSWORD_MAX_LENGTH}
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="请再次输入密码"
            disabled={pending}
            required
          />
          <button
            type="button"
            className="auth-password-toggle"
            onClick={() => setShowConfirmation((value) => !value)}
            disabled={pending}
            aria-label={showConfirmation ? '隐藏确认密码' : '显示确认密码'}
          >
            <EyeIcon crossed={showConfirmation} />
          </button>
        </div>

        {visibleError ? (
          <p className="auth-error" role="alert">
            {visibleError}
          </p>
        ) : null}

        <button type="submit" className="auth-register-submit" disabled={pending}>
          {pending ? '正在创建账户…' : '创建账户'}
        </button>
      </form>

      <p className="auth-register-terms">注册即表示你同意服务条款和隐私政策</p>
    </div>
  )
}
