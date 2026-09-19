import {
  EMAIL_MAX_LENGTH,
  isValidEmailAddress,
  isValidPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@image-playground/shared'
import { type FormEvent, type ReactNode, useState } from 'react'
import { useTranslation } from '../i18n'

type ValidationErrorKey =
  | 'validation.invalidEmail'
  | 'validation.passwordLength'
  | 'validation.passwordMismatch'

export interface RegistrationCredentials {
  username: string
  password: string
}

interface RegistrationPanelProps {
  pending: boolean
  error: string | null
  onBack: () => void
  onRegister: (credentials: RegistrationCredentials) => void
  children?: ReactNode
  invitationField?: ReactNode
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

export function RegistrationPanel({
  pending,
  error,
  onBack,
  onRegister,
  children,
  invitationField,
}: RegistrationPanelProps) {
  const { t } = useTranslation('auth')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  // 存 key 而不是译文：切语言时这条校验提示会跟着当前语言重新渲染。
  const [validationErrorKey, setValidationErrorKey] = useState<ValidationErrorKey | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (!isValidEmailAddress(normalizedEmail)) {
      setValidationErrorKey('validation.invalidEmail')
      return
    }
    if (!isValidPassword(password)) {
      setValidationErrorKey('validation.passwordLength')
      return
    }
    if (password !== confirmPassword) {
      setValidationErrorKey('validation.passwordMismatch')
      return
    }
    setValidationErrorKey(null)
    onRegister({ username: normalizedEmail, password })
  }

  const visibleError = validationErrorKey
    ? t(validationErrorKey, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
    : error

  return (
    <div className="auth-form-view auth-registration">
      <button type="button" className="auth-back" onClick={onBack} disabled={pending}>
        <span aria-hidden>←</span>
        {t('registration.back')}
      </button>

      <div className="auth-form-heading">
        <h1 tabIndex={-1}>{t('registration.title')}</h1>
        <p>{t('registration.subtitle')}</p>
      </div>
      {children}

      <form onSubmit={submit} className="auth-form" noValidate>
        <label className="auth-field" htmlFor="registration-email">
          <span>{t('registration.emailLabel')}</span>
          <input
            id="registration-email"
            name="username"
            type="email"
            autoComplete="email"
            maxLength={EMAIL_MAX_LENGTH}
            value={email}
            onChange={(event) => setEmail(event.currentTarget.value)}
            placeholder={t('registration.emailPlaceholder')}
            disabled={pending}
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>

        <label className="auth-field" htmlFor="registration-password">
          <span>{t('registration.passwordLabel')}</span>
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
              placeholder={t('registration.passwordPlaceholder', {
                min: PASSWORD_MIN_LENGTH,
                max: PASSWORD_MAX_LENGTH,
              })}
              disabled={pending}
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              disabled={pending}
              aria-label={showPassword ? t('password.hide') : t('password.show')}
            >
              <EyeIcon crossed={showPassword} />
            </button>
          </div>
        </label>

        <label className="auth-field" htmlFor="registration-confirm-password">
          <span>{t('registration.confirmationLabel')}</span>
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
              placeholder={t('registration.confirmationPlaceholder')}
              disabled={pending}
              required
            />
            <button
              type="button"
              onClick={() => setShowConfirmation((value) => !value)}
              disabled={pending}
              aria-label={
                showConfirmation ? t('password.hideConfirmation') : t('password.showConfirmation')
              }
            >
              <EyeIcon crossed={showConfirmation} />
            </button>
          </div>
        </label>

        {invitationField}

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
              {t('registration.submitting')}
            </>
          ) : (
            t('registration.submit')
          )}
        </button>
      </form>

      <p className="auth-switch">
        {t('registration.haveAccount')}
        <button type="button" onClick={onBack} disabled={pending}>
          {t('registration.back')}
        </button>
      </p>
      <p className="auth-terms">{t('registration.terms')}</p>
    </div>
  )
}
