import {
  isValidPassword,
  type LoginMethodsView,
  OAUTH_LINK_ERROR_QUERY_PARAM,
  OAUTH_LINK_QUERY_PARAM,
  type OAuthProviderView,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@image-playground/shared'
import { type FormEvent, useEffect, useState } from 'react'
import Dialog from '../components/patterns/Dialog'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useTranslation } from '../i18n'
import {
  AuthRequestError,
  fetchLoginMethods,
  fetchOAuthProviders,
  oauthLinkUrl,
  unlinkOAuthProvider,
  updateOwnPassword,
} from '../lib/authClient'

/**
 * 错误一律以 key 的形式在 state 里流转，渲染时才翻译：切语言后已经显示的报错会跟着变，
 * 且 `errors:<flow>.<code>` 的叶子名与 BFF 返回的 `error.code` 同名，对不上时一眼可见。
 */
type PanelErrorKey =
  | 'errors:link.identity_taken'
  | 'errors:link.unauthenticated'
  | 'errors:link.access_denied'
  | 'errors:link.fallback'
  | 'errors:password.invalid_credentials'
  | 'errors:password.current_password_required'
  | 'errors:password.invalid_password'
  | 'errors:password.rate_limited'
  | 'errors:password.fallback'
  | 'errors:unlink.last_login_method'
  | 'errors:unlink.not_linked'
  | 'errors:unlink.fallback'
  | 'auth:validation.passwordLength'
  | 'auth:validation.passwordMismatch'

function linkErrorKey(code: string): PanelErrorKey {
  if (code === 'identity_taken') return 'errors:link.identity_taken'
  if (code === 'unauthenticated') return 'errors:link.unauthenticated'
  if (code === 'access_denied') return 'errors:link.access_denied'
  return 'errors:link.fallback'
}

function passwordErrorKey(error: unknown): PanelErrorKey {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_credentials') return 'errors:password.invalid_credentials'
    if (error.code === 'current_password_required') {
      return 'errors:password.current_password_required'
    }
    if (error.code === 'invalid_password') return 'errors:password.invalid_password'
    if (error.code === 'rate_limited') return 'errors:password.rate_limited'
  }
  return 'errors:password.fallback'
}

function unlinkErrorKey(error: unknown): PanelErrorKey {
  if (error instanceof AuthRequestError) {
    if (error.code === 'last_login_method') return 'errors:unlink.last_login_method'
    if (error.code === 'not_linked') return 'errors:unlink.not_linked'
  }
  return 'errors:unlink.fallback'
}

type PanelNoticeKey = 'methods.passwordUpdated' | 'methods.passwordSet' | 'methods.unlinked'

type PanelNotice = { readonly key: PanelNoticeKey } | { readonly linkedProvider: string }

export function LoginMethodsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['auth', 'errors'])
  const [methods, setMethods] = useState<LoginMethodsView | null>(null)
  const [providers, setProviders] = useState<OAuthProviderView[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<PanelNotice | null>(null)
  const [errorKey, setErrorKey] = useState<PanelErrorKey | null>(null)

  const noticeText = (value: PanelNotice): string => {
    if ('key' in value) return t(value.key)
    const label = providers.find((provider) => provider.id === value.linkedProvider)?.label
    return t('methods.linkedProvider', { provider: label ?? value.linkedProvider })
  }
  const errorText = errorKey
    ? t(errorKey, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })
    : null

  useEffect(() => {
    let cancelled = false
    void Promise.all([fetchLoginMethods(), fetchOAuthProviders()]).then(
      ([loaded, available]) => {
        if (cancelled) return
        setMethods(loaded)
        setProviders(available)
      },
      () => {
        if (!cancelled) setLoadFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)
    const linked = url.searchParams.get(OAUTH_LINK_QUERY_PARAM)
    const failed = url.searchParams.get(OAUTH_LINK_ERROR_QUERY_PARAM)
    if (!linked && !failed) return
    if (failed) setErrorKey(linkErrorKey(failed))
    else if (linked) setNotice({ linkedProvider: linked })
    // Strip the parameters so a reload does not resurface an outcome the user already saw.
    url.searchParams.delete(OAUTH_LINK_QUERY_PARAM)
    url.searchParams.delete(OAUTH_LINK_ERROR_QUERY_PARAM)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  async function submitPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (pending || !methods) return
    setNotice(null)
    if (!isValidPassword(newPassword)) {
      setErrorKey('auth:validation.passwordLength')
      return
    }
    if (newPassword !== confirmation) {
      setErrorKey('auth:validation.passwordMismatch')
      return
    }

    setPending(true)
    setErrorKey(null)
    try {
      await updateOwnPassword({
        currentPassword: methods.password ? currentPassword : undefined,
        newPassword,
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setNotice({ key: methods.password ? 'methods.passwordUpdated' : 'methods.passwordSet' })
      setMethods(await fetchLoginMethods())
    } catch (err) {
      setErrorKey(passwordErrorKey(err))
    } finally {
      setPending(false)
    }
  }

  async function unlink(provider: string): Promise<void> {
    if (pending) return
    setPending(true)
    setErrorKey(null)
    setNotice(null)
    try {
      await unlinkOAuthProvider(provider)
      setNotice({ key: 'methods.unlinked' })
      setMethods(await fetchLoginMethods())
    } catch (err) {
      setErrorKey(unlinkErrorKey(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog onClose={onClose} tier="raised" title={t('methods.title')}>
      {notice ? (
        <p className="mb-4 rounded-xl bg-success/10 px-3 py-2 text-body-sm text-success dark:bg-success/10 dark:text-success">
          {noticeText(notice)}
        </p>
      ) : null}
      {errorText ? (
        <p
          role="alert"
          className="mb-4 rounded-xl bg-destructive/10 px-3 py-2 text-body-sm text-destructive dark:bg-destructive/10 dark:text-destructive"
        >
          {errorText}
        </p>
      ) : null}

      {loadFailed ? (
        <p className="text-body-sm text-muted-foreground">{t('methods.loadFailed')}</p>
      ) : !methods ? (
        <p className="text-body-sm text-muted-foreground">{t('methods.loading')}</p>
      ) : (
        <>
          <section className="mb-6">
            <h4 className="mb-1 text-sm font-medium text-foreground">
              {methods.password ? t('methods.changePassword') : t('methods.setPassword')}
            </h4>
            <p className="mb-3 text-xs text-muted-foreground">
              {methods.password ? t('methods.changePasswordHint') : t('methods.setPasswordHint')}
            </p>
            <form className="space-y-4" onSubmit={(event) => void submitPassword(event)}>
              {methods.password ? (
                <div className="grid gap-2">
                  <Label htmlFor="login-methods-current-password">
                    {t('methods.currentPassword')}
                  </Label>
                  <Input
                    id="login-methods-current-password"
                    name="current-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder={t('methods.currentPassword')}
                    aria-label={t('methods.currentPassword')}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                    disabled={pending}
                  />
                </div>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="login-methods-new-password">{t('methods.newPassword')}</Label>
                <Input
                  id="login-methods-new-password"
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('methods.newPassword')}
                  aria-label={t('methods.newPassword')}
                  maxLength={PASSWORD_MAX_LENGTH}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.currentTarget.value)}
                  disabled={pending}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="login-methods-confirm-password">
                  {t('methods.confirmNewPassword')}
                </Label>
                <Input
                  id="login-methods-confirm-password"
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('methods.confirmNewPassword')}
                  aria-label={t('methods.confirmNewPassword')}
                  maxLength={PASSWORD_MAX_LENGTH}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                  disabled={pending}
                />
              </div>
              <Button type="submit" disabled={pending} className="w-full">
                {methods.password ? t('methods.updatePassword') : t('methods.setPassword')}
              </Button>
            </form>
          </section>

          {providers.length > 0 ? (
            <section>
              <h4 className="mb-3 text-sm font-medium text-foreground">
                {t('methods.providersTitle')}
              </h4>
              <ul className="space-y-4">
                {providers.map((provider) => {
                  const identity = methods.identities.find(
                    (linked) => linked.provider === provider.id,
                  )
                  return (
                    <li
                      key={provider.id}
                      className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{provider.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {identity
                            ? (identity.email ?? t('methods.linked'))
                            : t('methods.notLinked')}
                        </span>
                      </span>
                      {identity ? (
                        <Button
                          type="button"
                          disabled={pending}
                          onClick={() => void unlink(provider.id)}
                          variant="ghost"
                          size="sm"
                          className="shrink-0 text-muted-foreground"
                        >
                          {t('methods.unlink')}
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            window.location.href = oauthLinkUrl(provider.id)
                          }}
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                        >
                          {t('methods.link')}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </Dialog>
  )
}
