import './appearance.css'
import { OAUTH_ERROR_QUERY_PARAM, type OAuthProviderView } from '@image-playground/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import Overlay from '../components/patterns/Overlay'
import { Button } from '../components/ui/button'
import { Icon } from '../components/ui/icon'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useTranslation } from '../i18n'
import {
  AuthRequestError,
  fetchOAuthProviders,
  loginUser,
  oauthStartUrl,
  registerUser,
  requestRegistrationVerification,
} from '../lib/authClient'
import { isClientCapabilityEnabled } from '../lib/clientCapabilities'
import { PrivateWebSupportsReferrals } from '../lib/privateOverlay'
import AuthConsent from './AuthConsent'
import type { LoginPromptReason } from './loginPrompt'
import { preservePendingSubmissionForLogin } from './pendingSubmission'
import { type RegistrationCredentials, RegistrationPanel } from './RegistrationPanel'

function ProviderMark({ provider }: { provider: OAuthProviderView }) {
  if (provider.id === 'google') return <span className="auth-provider-google">G</span>
  return <span className="auth-provider-generic">{provider.label.slice(0, 1)}</span>
}

function AuthBrand() {
  const { t } = useTranslation('auth')
  return (
    <div className="auth-wordmark">
      <img src="/brand/muvloom-mark.svg" alt="" width={28} height={28} />
      <span>{t('brand.name')}</span>
    </div>
  )
}
function AuthShowcase() {
  const { t } = useTranslation('auth')
  return (
    <section className="auth-creator-art">
      <img className="auth-creator-cover" src="/website-assets/creator-hero.webp" alt="" />
      <AuthBrand />
      <h2>
        {t('showcase.headlineLine1')}
        <br />
        {t('showcase.headlineLine2')}
      </h2>
    </section>
  )
}

/** 叶子名与 BFF 的 `error.code` 同名，新增错误码时两边对照即可。 */
type LoginErrorKey =
  | 'login.invalid_credentials'
  | 'login.rate_limited'
  | 'login.fallback'
  | 'oauth.registration_closed'
  | 'oauth.invalid_referral_code'
  | 'oauth.registration_reward_unavailable'
  | 'oauth.account_disabled'
  | 'oauth.access_denied'
  | 'oauth.fallback'
  | 'registration.username_taken'
  | 'registration.invalid_username'
  | 'registration.invalid_password'
  | 'registration.rate_limited'
  | 'registration.invalid_referral_code'
  | 'registration.registration_reward_unavailable'
  | 'registration.fallback'
  | 'registration.email_delivery_failed'
  | 'registration.email_verification_required'
  | 'registration.invalid_email_verification'
  | 'registration.email_verification_expired'

function loginErrorKey(error: unknown): LoginErrorKey {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_credentials') return 'login.invalid_credentials'
    if (error.code === 'rate_limited') return 'login.rate_limited'
  }
  return 'login.fallback'
}

function oauthErrorKey(code: string): LoginErrorKey {
  if (code === 'registration_closed') return 'oauth.registration_closed'
  if (code === 'invalid_referral_code') return 'oauth.invalid_referral_code'
  if (code === 'registration_reward_unavailable') return 'oauth.registration_reward_unavailable'
  if (code === 'account_disabled') return 'oauth.account_disabled'
  if (code === 'access_denied') return 'oauth.access_denied'
  return 'oauth.fallback'
}

function registrationErrorKey(error: unknown): LoginErrorKey {
  if (error instanceof AuthRequestError) {
    if (error.code === 'username_taken') return 'registration.username_taken'
    if (error.code === 'invalid_username') return 'registration.invalid_username'
    if (error.code === 'invalid_password') return 'registration.invalid_password'
    if (error.code === 'rate_limited') return 'registration.rate_limited'
    if (error.code === 'email_delivery_failed') return 'registration.email_delivery_failed'
    if (error.code === 'email_verification_required') {
      return 'registration.email_verification_required'
    }
    if (error.code === 'invalid_email_verification') {
      return 'registration.invalid_email_verification'
    }
    if (error.code === 'email_verification_expired') {
      return 'registration.email_verification_expired'
    }
    if (error.code === 'invalid_referral_code') return 'registration.invalid_referral_code'
    if (error.code === 'registration_reward_unavailable') {
      return 'registration.registration_reward_unavailable'
    }
  }
  return 'registration.fallback'
}

interface LoginDialogProps {
  onClose: () => void
  presentation?: 'dialog' | 'page'
  plansHref?: string
  onAuthenticated?: () => void
  /** 为什么弹出来：决定副标题那一句，其余流程完全一样。 */
  reason?: LoginPromptReason
}

/**
 * 登录框。访客不登录也能用工作台，这个框只在他按下需要账号的动作时出现，
 * 所以它是浮层而不是整页——身后那半张草稿、那条提示词都还在。
 *
 * 登录成功后整页 reload：地址栏不动，重新启动时 AuthGate 会把匿名期间攒下的
 * 本地历史认领进账号，channel 与同步引擎也一并按新身份重来。
 */
export function LoginDialog({
  onClose,
  reason = 'gated-action',
  presentation = 'dialog',
  onAuthenticated,
  plansHref,
}: LoginDialogProps) {
  const { t } = useTranslation('auth')
  const { t: tError } = useTranslation('errors')
  const registrationEnabled = isClientCapabilityEnabled('accounts:self-register')
  const emailVerificationEnabled = isClientCapabilityEnabled('accounts:email-verification')
  const referralEnabled =
    PrivateWebSupportsReferrals &&
    registrationEnabled &&
    isClientCapabilityEnabled('billing:credits')
  const [referralCode, setReferralCode] = useState(() =>
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search).get('ref') ?? ''),
  )
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorKey, setErrorKey] = useState<LoginErrorKey | null>(null)
  const [view, setView] = useState<'login' | 'registration'>(
    referralEnabled && referralCode ? 'registration' : 'login',
  )
  const panelRef = useRef<HTMLDivElement>(null)
  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current !== view) {
      panelRef.current?.querySelector('h1')?.focus({ preventScroll: true })
      previousView.current = view
    }
  }, [view])
  const [providers, setProviders] = useState<OAuthProviderView[]>([])
  const error = errorKey ? tError(errorKey) : null

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
    setErrorKey(oauthErrorKey(code))
    // Strip the parameter so a reload does not resurface a failure the user already saw.
    url.searchParams.delete(OAUTH_ERROR_QUERY_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!username.trim() || !password || pending) return
    setPending(true)
    setErrorKey(null)
    try {
      await loginUser(username, password)
      preservePendingSubmissionForLogin()
      if (onAuthenticated) onAuthenticated()
      else window.location.reload()
    } catch (err) {
      setErrorKey(loginErrorKey(err))
      setPending(false)
    }
  }

  async function requestVerification(
    email: string,
  ): Promise<{ challengeId: string; expiresInSeconds: number } | null> {
    if (pending) return null
    setPending(true)
    setErrorKey(null)
    try {
      return await requestRegistrationVerification(email)
    } catch (err) {
      setErrorKey(registrationErrorKey(err))
      return null
    } finally {
      setPending(false)
    }
  }

  async function submitRegistration(credentials: RegistrationCredentials): Promise<void> {
    if (pending) return
    setPending(true)
    setErrorKey(null)
    try {
      await registerUser(credentials.username, credentials.password, {
        referralCode: referralEnabled ? referralCode : undefined,
        verification: credentials.verification,
      })
      preservePendingSubmissionForLogin()
      if (onAuthenticated) onAuthenticated()
      else window.location.reload()
    } catch (err) {
      setErrorKey(registrationErrorKey(err))
      setPending(false)
    }
  }

  const invitationField = referralEnabled ? (
    <div className="auth-referral">
      <Label className="mt-4 grid gap-2 first:mt-0">
        <span>{t('referral.label')}</span>
        <Input
          name="referral_code"
          value={referralCode}
          maxLength={64}
          onChange={(event) => {
            setReferralCode(event.currentTarget.value)
            setErrorKey(null)
          }}
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          disabled={pending}
          placeholder={t('referral.placeholder')}
        />
      </Label>
    </div>
  ) : null
  const providerButtons =
    providers.length > 0 ? (
      <>
        <div className="grid auto-cols-fr grid-flow-col gap-2" data-auth-providers>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                preservePendingSubmissionForLogin()
                window.location.href = oauthStartUrl(
                  provider.id,
                  view === 'registration' && referralEnabled ? referralCode : undefined,
                )
              }}
            >
              <ProviderMark provider={provider} />
              <span>{provider.label}</span>
            </Button>
          ))}
        </div>
        <div className="auth-divider">
          <span>
            {view === 'registration' ? t('login.dividerRegister') : t('login.dividerLogin')}
          </span>
        </div>
      </>
    ) : null

  const content = (
    <div
      role={presentation === 'dialog' ? 'dialog' : undefined}
      aria-modal={presentation === 'dialog' ? true : undefined}
      aria-label={t('dialog.label')}
      className={`auth-surface ${presentation === 'page' ? 'auth-page' : 'auth-dialog'}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-4 top-4 z-10 text-muted-foreground"
        onClick={onClose}
        aria-label={presentation === 'page' ? t('page.back') : t('dialog.close')}
      >
        <Icon name={presentation === 'page' ? 'back' : 'close'} />
      </Button>

      {presentation === 'page' ? <AuthShowcase /> : null}

      <section className="auth-panel">
        <div className="auth-panel-content" ref={panelRef}>
          <AuthBrand />
          {view === 'registration' ? (
            <RegistrationPanel
              plansHref={plansHref}
              pending={pending}
              error={error}
              verificationEnabled={emailVerificationEnabled}
              onRequestVerification={requestVerification}
              onBack={() => {
                setErrorKey(null)
                setView('login')
              }}
              invitationField={invitationField}
              onRegister={(credentials) => void submitRegistration(credentials)}
            >
              {providerButtons}
            </RegistrationPanel>
          ) : (
            <div className="auth-form-view auth-login">
              <div className="mb-6">
                <h1 className="text-xl font-semibold text-foreground" tabIndex={-1}>
                  {t('login.title')}
                </h1>
                <p className="sr-only">
                  {reason === 'session-expired'
                    ? t('dialog.expiredSubtitle')
                    : t('dialog.gatedSubtitle')}
                </p>
              </div>

              {providerButtons}

              <form
                className="auth-form"
                onSubmit={(event) => void submit(event)}
                aria-label={t('login.formLabel')}
              >
                <Label className="mt-4 grid gap-2 first:mt-0">
                  <span>{t('login.emailLabel')}</span>
                  <Input
                    name="username"
                    type="text"
                    inputMode="email"
                    value={username}
                    onChange={(event) => setUsername(event.currentTarget.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={pending}
                    placeholder={t('login.emailPlaceholder')}
                  />
                </Label>

                <Label className="mt-4 grid gap-2 first:mt-0">
                  <span>{t('login.passwordLabel')}</span>
                  <div className="relative">
                    <Input
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      className="pr-10"
                      value={password}
                      onChange={(event) => setPassword(event.currentTarget.value)}
                      autoComplete="current-password"
                      disabled={pending}
                      placeholder={t('login.passwordPlaceholder')}
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

                <div className="auth-message-slot" aria-live="polite">
                  {error ? (
                    <p role="alert" className="auth-error">
                      {error}
                    </p>
                  ) : null}
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={pending || !username.trim() || !password}
                >
                  {pending ? (
                    <>
                      <Icon name="loading" className="animate-spin" />
                      {t('login.submitting')}
                    </>
                  ) : (
                    t('login.submit')
                  )}
                </Button>
              </form>

              <p className="mt-6 flex flex-wrap items-center justify-center gap-1 text-xs text-muted-foreground">
                {t('login.noAccount')}
                {registrationEnabled ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => {
                      setErrorKey(null)
                      setView('registration')
                    }}
                  >
                    {t('login.registerLink')}
                  </Button>
                ) : (
                  <span>{t('login.registrationClosed')}</span>
                )}
              </p>
              <AuthConsent plansHref={plansHref} kind="login" />
            </div>
          )}
        </div>
      </section>
    </div>
  )
  return presentation === 'page' ? (
    <main>{content}</main>
  ) : (
    <Overlay onClose={onClose} tier="raised" role="none">
      {content}
    </Overlay>
  )
}
