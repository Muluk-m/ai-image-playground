import {
  EMAIL_MAX_LENGTH,
  isValidEmailAddress,
  isValidPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
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
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (!isValidEmailAddress(normalizedEmail)) {
      setValidationError('请输入有效的邮箱地址')
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
    onRegister({ username: normalizedEmail, password })
  }

  const visibleError = validationError || error

  return (
    <div className="auth-form-view auth-registration">
      <button type="button" className="auth-back" onClick={onBack} disabled={pending}>
        <span aria-hidden>←</span>
        返回登录
      </button>

      <div className="auth-form-heading">
        <h1>创建账户</h1>
        <p>注册后即可开始你的创作旅程</p>
      </div>

      <form onSubmit={submit} className="auth-form" noValidate>
        <label className="auth-field" htmlFor="registration-email">
          <span>邮箱地址</span>
          <input
            id="registration-email"
            name="username"
            type="email"
            autoComplete="email"
            maxLength={EMAIL_MAX_LENGTH}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder="请输入你的邮箱地址"
            disabled={pending}
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            required
          />
        </label>

        <label className="auth-field" htmlFor="registration-password">
          <span>密码</span>
          <div className="auth-password">
            <input
              id="registration-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
              placeholder={`请输入 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位密码`}
              disabled={pending}
              required
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

        <label className="auth-field" htmlFor="registration-confirm-password">
          <span>确认密码</span>
          <div className="auth-password">
            <input
              id="registration-confirm-password"
              name="confirmPassword"
              type={showConfirmation ? 'text' : 'password'}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={PASSWORD_MAX_LENGTH}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.currentTarget.value)}
              placeholder="请再次输入密码"
              disabled={pending}
              required
            />
            <button
              type="button"
              onClick={() => setShowConfirmation((value) => !value)}
              disabled={pending}
              aria-label={showConfirmation ? '隐藏确认密码' : '显示确认密码'}
            >
              <EyeIcon crossed={showConfirmation} />
            </button>
          </div>
        </label>

        <div className="auth-message-slot" aria-live="polite">
          {visibleError ? (
            <p className="auth-error" role="alert">
              {visibleError}
            </p>
          ) : null}
        </div>

        <button type="submit" className="auth-submit" disabled={pending}>
          {pending ? (
            <>
              <i className="auth-spinner" aria-hidden />
              正在创建账户
            </>
          ) : (
            '创建账户'
          )}
        </button>
      </form>

      <p className="auth-switch">
        已有账户？
        <button type="button" onClick={onBack} disabled={pending}>
          返回登录
        </button>
      </p>
      <p className="auth-terms">注册即表示你同意我们的服务条款和隐私政策</p>
    </div>
  )
}
