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
import Overlay from '../components/Overlay'
import {
  AuthRequestError,
  fetchLoginMethods,
  fetchOAuthProviders,
  oauthLinkUrl,
  unlinkOAuthProvider,
  updateOwnPassword,
} from '../lib/authClient'

function linkErrorMessage(code: string): string {
  if (code === 'identity_taken') return '该第三方账号已绑定到其他账户'
  if (code === 'unauthenticated') return '登录状态已失效，请重新登录后再绑定'
  if (code === 'access_denied') return '你取消了第三方授权'
  return '绑定失败，请稍后重试'
}

function passwordErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'invalid_credentials') return '当前密码不正确'
    if (error.code === 'current_password_required') return '请填写当前密码'
    if (error.code === 'invalid_password') {
      return `密码需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`
    }
    if (error.code === 'rate_limited') return '尝试次数过多，请稍后再试'
  }
  return '暂时无法修改密码，请稍后重试'
}

function unlinkErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    if (error.code === 'last_login_method') return '解绑后将无法登录，请先设置密码'
    if (error.code === 'not_linked') return '该账号尚未绑定'
  }
  return '暂时无法解绑，请稍后重试'
}

type PanelNotice = { readonly text: string } | { readonly linkedProvider: string }

function noticeText(notice: PanelNotice, providers: OAuthProviderView[]): string {
  if ('text' in notice) return notice.text
  const label = providers.find((provider) => provider.id === notice.linkedProvider)?.label
  return `已绑定 ${label ?? notice.linkedProvider}`
}

const FIELD_CLASS =
  'w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-violet-400 disabled:opacity-50 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-100'

export function LoginMethodsPanel({ onClose }: { onClose: () => void }) {
  const [methods, setMethods] = useState<LoginMethodsView | null>(null)
  const [providers, setProviders] = useState<OAuthProviderView[]>([])
  const [loadFailed, setLoadFailed] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<PanelNotice | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    if (failed) setError(linkErrorMessage(failed))
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
      setError(`密码需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`)
      return
    }
    if (newPassword !== confirmation) {
      setError('两次输入的密码不一致')
      return
    }

    setPending(true)
    setError(null)
    try {
      await updateOwnPassword({
        currentPassword: methods.password ? currentPassword : undefined,
        newPassword,
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmation('')
      setNotice({ text: methods.password ? '密码已更新' : '密码已设置' })
      setMethods(await fetchLoginMethods())
    } catch (err) {
      setError(passwordErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  async function unlink(provider: string): Promise<void> {
    if (pending) return
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await unlinkOAuthProvider(provider)
      setNotice({ text: '已解绑' })
      setMethods(await fetchLoginMethods())
    } catch (err) {
      setError(unlinkErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <Overlay onClose={onClose} tier="raised">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-methods-title"
        className="relative z-10 flex max-h-[85vh] w-full max-w-md flex-col overflow-y-auto rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in custom-scrollbar dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3
            id="login-methods-title"
            className="text-base font-semibold text-gray-800 dark:text-gray-100"
          >
            登录方式
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100"
          >
            关闭
          </button>
        </div>

        {notice ? (
          <p className="mb-4 rounded-xl bg-emerald-50 px-3 py-2 text-[13px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            {noticeText(notice, providers)}
          </p>
        ) : null}
        {error ? (
          <p
            role="alert"
            className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-[13px] text-red-600 dark:bg-red-500/10 dark:text-red-300"
          >
            {error}
          </p>
        ) : null}

        {loadFailed ? (
          <p className="text-[13px] text-gray-500 dark:text-gray-400">
            暂时无法读取登录方式，请稍后重试
          </p>
        ) : !methods ? (
          <p className="text-[13px] text-gray-500 dark:text-gray-400">加载中</p>
        ) : (
          <>
            <section className="mb-6">
              <h4 className="mb-1 text-sm font-medium text-gray-700 dark:text-gray-200">
                {methods.password ? '修改密码' : '设置密码'}
              </h4>
              <p className="mb-3 text-[12px] text-gray-500 dark:text-gray-400">
                {methods.password ? '用邮箱与密码登录' : '设置后即可用邮箱与密码登录'}
              </p>
              <form className="space-y-2" onSubmit={(event) => void submitPassword(event)}>
                {methods.password ? (
                  <input
                    name="current-password"
                    type="password"
                    autoComplete="current-password"
                    placeholder="当前密码"
                    aria-label="当前密码"
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.currentTarget.value)}
                    disabled={pending}
                    className={FIELD_CLASS}
                  />
                ) : null}
                <input
                  name="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="新密码"
                  aria-label="新密码"
                  maxLength={PASSWORD_MAX_LENGTH}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.currentTarget.value)}
                  disabled={pending}
                  className={FIELD_CLASS}
                />
                <input
                  name="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="确认新密码"
                  aria-label="确认新密码"
                  maxLength={PASSWORD_MAX_LENGTH}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.currentTarget.value)}
                  disabled={pending}
                  className={FIELD_CLASS}
                />
                <button
                  type="submit"
                  disabled={pending}
                  className="w-full rounded-xl bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-800 disabled:cursor-wait disabled:opacity-50 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100"
                >
                  {methods.password ? '更新密码' : '设置密码'}
                </button>
              </form>
            </section>

            {providers.length > 0 ? (
              <section>
                <h4 className="mb-3 text-sm font-medium text-gray-700 dark:text-gray-200">
                  第三方账号
                </h4>
                <ul className="space-y-2">
                  {providers.map((provider) => {
                    const identity = methods.identities.find(
                      (linked) => linked.provider === provider.id,
                    )
                    return (
                      <li
                        key={provider.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-3 py-2 dark:border-white/10"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm text-gray-800 dark:text-gray-100">
                            {provider.label}
                          </span>
                          <span className="block truncate text-[12px] text-gray-500 dark:text-gray-400">
                            {identity ? (identity.email ?? '已绑定') : '未绑定'}
                          </span>
                        </span>
                        {identity ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void unlink(provider.id)}
                            className="shrink-0 rounded-lg px-3 py-1.5 text-[13px] font-medium text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:cursor-wait disabled:opacity-50 dark:text-gray-400 dark:hover:bg-white/10 dark:hover:text-gray-100"
                          >
                            解绑
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => {
                              window.location.href = oauthLinkUrl(provider.id)
                            }}
                            className="shrink-0 rounded-lg border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-wait disabled:opacity-50 dark:border-white/10 dark:text-gray-200 dark:hover:bg-white/10"
                          >
                            绑定
                          </button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Overlay>
  )
}
