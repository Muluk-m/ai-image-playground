import { OAUTH_ERROR_QUERY_PARAM, type OAuthProviderView } from '@image-playground/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import ThemeToggleButton from '../components/ThemeToggleButton'
import { type AppLocale, SUPPORTED_LOCALES, useTranslation } from '../i18n'
import { useLocalePicker } from '../i18n/useLocalePicker'
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
  const { t } = useTranslation('auth')
  return (
    <section className="auth-showcase">
      <header className="auth-brand">
        <img src="/brand/muvloom-mark.svg" alt="" width="30" height="30" />
        <span>{t('brand.name')}</span>
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
          {t('showcase.headlineLine1')}
          <br />
          {t('showcase.headlineLine2')}
        </h2>
        <p>{t('showcase.tagline')}</p>
      </div>

      <div className="auth-benefits">
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="model" />
          </span>
          <strong>{t('showcase.benefit.model.title')}</strong>
          <p>
            {t('showcase.benefit.model.line1')}
            <br />
            {t('showcase.benefit.model.line2')}
          </p>
        </div>
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="speed" />
          </span>
          <strong>{t('showcase.benefit.speed.title')}</strong>
          <p>
            {t('showcase.benefit.speed.line1')}
            <br />
            {t('showcase.benefit.speed.line2')}
          </p>
        </div>
        <div>
          <span className="auth-benefit-icon">
            <FeatureIcon kind="security" />
          </span>
          <strong>{t('showcase.benefit.security.title')}</strong>
          <p>
            {t('showcase.benefit.security.line1')}
            <br />
            {t('showcase.benefit.security.line2')}
          </p>
        </div>
      </div>
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

function LanguagePicker() {
  const { t } = useTranslation('common')
  const { locale, change } = useLocalePicker()
  return (
    <label className="auth-language">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.2 2.5 3.3 5.5 3.3 9S14.2 18.5 12 21c-2.2-2.5-3.3-5.5-3.3-9S9.8 5.5 12 3Z" />
      </svg>
      <select
        aria-label={t('locale.label')}
        value={locale}
        onChange={(event) => change(event.currentTarget.value as AppLocale)}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>
            {t(`locale.${locale}` as const)}
          </option>
        ))}
      </select>
    </label>
  )
}

export function LoginScreen() {
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
  const [referralExpanded, setReferralExpanded] = useState(Boolean(referralCode))
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
      window.location.reload()
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
      window.location.reload()
    } catch (err) {
      setErrorKey(registrationErrorKey(err))
      setPending(false)
    }
  }

  const invitationField = referralEnabled ? (
    <details
      className="auth-referral"
      open={referralExpanded}
      onToggle={(event) => setReferralExpanded(event.currentTarget.open)}
    >
      <summary>
        {t('referral.summary')}
        <span>{t('referral.optional')}</span>
      </summary>
      <label className="auth-field">
        <span>{t('referral.label')}</span>
        <input
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
      </label>
    </details>
  ) : null
  const providerButtons =
    providers.length > 0 ? (
      <>
        <div className="auth-providers">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={pending}
              onClick={() => {
                window.location.href = oauthStartUrl(
                  provider.id,
                  view === 'registration' && referralEnabled ? referralCode : undefined,
                )
              }}
            >
              <ProviderMark provider={provider} />
              <span>{provider.label}</span>
            </button>
          ))}
        </div>
        <div className="auth-divider">
          <span>
            {view === 'registration' ? t('login.dividerRegister') : t('login.dividerLogin')}
          </span>
        </div>
      </>
    ) : null

  return (
    <main className={`auth-shell${view === 'registration' ? ' auth-shell--registration' : ''}`}>
      <div className="auth-frame">
        <AuthShowcase />

        <section className="auth-panel">
          {/* 显示设置在登录前就要能改：这里没有头像菜单，所以语言与主题各放一个控件。 */}
          <div className="auth-display">
            <LanguagePicker />
            <ThemeToggleButton className="auth-theme" />
          </div>

          <div className="auth-panel-content" ref={panelRef}>
            {view === 'registration' ? (
              <RegistrationPanel
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
                <div className="auth-form-heading">
                  <h1 tabIndex={-1}>{t('login.title')}</h1>
                  <p>{t('login.subtitle')}</p>
                </div>

                {providerButtons}

                <form
                  className="auth-form"
                  onSubmit={(event) => void submit(event)}
                  aria-label={t('login.formLabel')}
                >
                  <label className="auth-field">
                    <span>{t('login.emailLabel')}</span>
                    <input
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
                  </label>

                  <label className="auth-field">
                    <span>{t('login.passwordLabel')}</span>
                    <div className="auth-password">
                      <input
                        name="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(event) => setPassword(event.currentTarget.value)}
                        autoComplete="current-password"
                        disabled={pending}
                        placeholder={t('login.passwordPlaceholder')}
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
                        {t('login.submitting')}
                      </>
                    ) : (
                      t('login.submit')
                    )}
                  </button>
                </form>

                <p className="auth-switch">
                  {t('login.noAccount')}
                  {registrationEnabled ? (
                    <button
                      type="button"
                      onClick={() => {
                        setErrorKey(null)
                        setView('registration')
                      }}
                    >
                      {t('login.registerLink')}
                    </button>
                  ) : (
                    <span>{t('login.registrationClosed')}</span>
                  )}
                </p>
                <p className="auth-terms">{t('login.terms')}</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  )
}
