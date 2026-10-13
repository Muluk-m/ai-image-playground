import {
  EMAIL_MAX_LENGTH,
  isValidEmailAddress,
  isValidPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@image-playground/shared'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Button } from '../components/ui/button'
import { Icon } from '../components/ui/icon'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useTranslation } from '../i18n'
import AuthConsent from './AuthConsent'

type ValidationErrorKey =
  | 'validation.invalidEmail'
  | 'validation.passwordLength'
  | 'validation.passwordMismatch'
  | 'validation.invalidVerificationCode'

export interface RegistrationCredentials {
  username: string
  password: string
  verification?: { challengeId: string; code: string }
}

export interface RegistrationVerificationChallenge {
  challengeId: string
  expiresInSeconds: number
}

interface RegistrationPanelProps {
  pending: boolean
  error: string | null
  verificationEnabled: boolean
  onBack: () => void
  onRequestVerification: (email: string) => Promise<RegistrationVerificationChallenge | null>
  onRegister: (credentials: RegistrationCredentials) => void
  children?: ReactNode
  invitationField?: ReactNode
}

export function RegistrationPanel({
  pending,
  error,
  verificationEnabled,
  onBack,
  onRequestVerification,
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
  const [challenge, setChallenge] = useState<RegistrationVerificationChallenge | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [resendSeconds, setResendSeconds] = useState(0)
  // 存 key 而不是译文：切语言时这条校验提示会跟着当前语言重新渲染。
  const [validationErrorKey, setValidationErrorKey] = useState<ValidationErrorKey | null>(null)

  useEffect(() => {
    if (resendSeconds <= 0) return
    const timer = window.setInterval(() => {
      setResendSeconds((seconds) => Math.max(0, seconds - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendSeconds])

  async function requestCode(normalizedEmail: string): Promise<void> {
    setValidationErrorKey(null)
    const issued = await onRequestVerification(normalizedEmail)
    if (!issued) return
    setChallenge(issued)
    setVerificationCode('')
    setResendSeconds(60)
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const normalizedEmail = email.trim()
    if (challenge) {
      if (!/^[0-9]{6}$/.test(verificationCode)) {
        setValidationErrorKey('validation.invalidVerificationCode')
        return
      }
      setValidationErrorKey(null)
      onRegister({
        username: normalizedEmail,
        password,
        verification: { challengeId: challenge.challengeId, code: verificationCode },
      })
      return
    }
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
    if (verificationEnabled) {
      await requestCode(normalizedEmail)
      return
    }
    setValidationErrorKey(null)
    onRegister({ username: normalizedEmail, password })
  }

  const visibleError = validationErrorKey
    ? t(validationErrorKey, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
    : error
  const returnToDetails = () => {
    setChallenge(null)
    setVerificationCode('')
    setValidationErrorKey(null)
  }

  return (
    <div className="auth-form-view auth-registration">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="mb-6 text-muted-foreground"
        onClick={challenge ? returnToDetails : onBack}
        disabled={pending}
      >
        <Icon name="back" />
        {challenge ? t('registration.verification.changeEmail') : t('registration.back')}
      </Button>

      <div className="mb-6">
        <h1 className="text-xl font-semibold text-foreground" tabIndex={-1}>
          {challenge ? t('registration.verification.title') : t('registration.title')}
        </h1>
        <p className="mt-2 text-body-sm text-muted-foreground">
          {challenge
            ? t('registration.verification.subtitle', { email: email.trim() })
            : t('registration.subtitle')}
        </p>
      </div>
      {challenge ? null : children}

      <form onSubmit={submit} className="auth-form" noValidate>
        {challenge ? (
          <Label className="mt-4 grid gap-2 first:mt-0" htmlFor="registration-verification-code">
            <span>{t('registration.verification.codeLabel')}</span>
            <Input
              id="registration-verification-code"
              name="verificationCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              value={verificationCode}
              onChange={(event) => {
                setVerificationCode(event.currentTarget.value.replace(/\D/g, '').slice(0, 6))
                setValidationErrorKey(null)
              }}
              placeholder={t('registration.verification.codePlaceholder')}
              disabled={pending}
              autoFocus
              required
            />
          </Label>
        ) : (
          <>
            <Label className="mt-4 grid gap-2 first:mt-0" htmlFor="registration-email">
              <span>{t('registration.emailLabel')}</span>
              <Input
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
            </Label>

            <Label className="mt-4 grid gap-2 first:mt-0" htmlFor="registration-password">
              <span>{t('registration.passwordLabel')}</span>
              <div className="relative">
                <Input
                  id="registration-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  className="pr-10"
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-0.5 top-0.5 text-muted-foreground"
                  onClick={() => setShowPassword((value) => !value)}
                  disabled={pending}
                  aria-label={showPassword ? t('password.hide') : t('password.show')}
                >
                  <Icon name={showPassword ? 'hidden' : 'visible'} />
                </Button>
              </div>
            </Label>

            <Label className="mt-4 grid gap-2 first:mt-0" htmlFor="registration-confirm-password">
              <span>{t('registration.confirmationLabel')}</span>
              <div className="relative">
                <Input
                  id="registration-confirm-password"
                  name="confirmPassword"
                  type={showConfirmation ? 'text' : 'password'}
                  className="pr-10"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.currentTarget.value)}
                  placeholder={t('registration.confirmationPlaceholder')}
                  disabled={pending}
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute right-0.5 top-0.5 text-muted-foreground"
                  onClick={() => setShowConfirmation((value) => !value)}
                  disabled={pending}
                  aria-label={
                    showConfirmation
                      ? t('password.hideConfirmation')
                      : t('password.showConfirmation')
                  }
                >
                  <Icon name={showConfirmation ? 'hidden' : 'visible'} />
                </Button>
              </div>
            </Label>

            {invitationField}
          </>
        )}

        <div className="auth-message-slot" aria-live="polite">
          {visibleError ? (
            <p className="auth-error" role="alert">
              {visibleError}
            </p>
          ) : null}
        </div>

        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? (
            <>
              <Icon name="loading" className="animate-spin" />
              {challenge
                ? t('registration.verification.verifying')
                : verificationEnabled
                  ? t('registration.verification.sending')
                  : t('registration.submitting')}
            </>
          ) : challenge ? (
            t('registration.verification.submit')
          ) : verificationEnabled ? (
            t('registration.verification.send')
          ) : (
            t('registration.submit')
          )}
        </Button>
      </form>

      {challenge ? (
        <p className="mt-6 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
          {t('registration.verification.notReceived')}
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={() => void requestCode(email.trim())}
            disabled={pending || resendSeconds > 0}
          >
            {resendSeconds > 0
              ? t('registration.verification.resendCountdown', { seconds: resendSeconds })
              : t('registration.verification.resend')}
          </Button>
        </p>
      ) : (
        <p className="mt-6 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
          {t('registration.haveAccount')}
          <Button type="button" variant="link" size="xs" onClick={onBack} disabled={pending}>
            {t('registration.back')}
          </Button>
        </p>
      )}
      <AuthConsent kind="registration" />
    </div>
  )
}
