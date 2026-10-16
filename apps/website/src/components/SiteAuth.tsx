import { OAUTH_ERROR_QUERY_PARAM } from '@image-playground/shared'
import { lazy, Suspense, useEffect, useState } from 'react'
import {
  discardPendingSubmission,
  hasPendingSubmission,
} from '../../../web/src/auth/pendingSubmission'
import Overlay from '../../../web/src/components/patterns/Overlay'
import { Button } from '../../../web/src/components/ui/button'
import { setDocumentTitleOverride, setLocale } from '../../../web/src/i18n'
import {
  AuthRequestError,
  getCurrentUser,
  noteBrowserSession,
  shouldProbeSession,
} from '../../../web/src/lib/authClient'
import {
  bootstrapClientCapabilities,
  isClientCapabilityEnabled,
} from '../../../web/src/lib/clientCapabilities'
import { loadRuntimeConfig } from '../../../web/src/lib/runtimeConfig'
import { initTheme } from '../../../web/src/theme'
import { copy, type Locale } from '../catalog'

const LoginDialog = lazy(() =>
  import('../../../web/src/auth/LoginDialog').then((module) => ({ default: module.LoginDialog })),
)

export default function SiteAuth({
  locale,
  page,
  open,
  onClose,
  onOpen,
}: {
  locale: Locale
  page: string
  open: boolean
  onOpen: () => void
  onClose: () => void
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const text = copy[locale]
  useEffect(() => {
    let active = true
    const title = document.title
    setDocumentTitleOverride(() => title)
    setStatus('loading')
    async function boot() {
      initTheme()
      await setLocale(locale)
      const runtime = await loadRuntimeConfig()
      if (!runtime.bff.enabled) throw new Error('BFF unavailable')
      await bootstrapClientCapabilities(true, runtime.bff.baseUrl, true)
      if (!active) return
      if (!isClientCapabilityEnabled('accounts:login')) {
        if (page === 'home' || page === 'login' || open) location.replace('/workbench')
        return
      }
      if (shouldProbeSession()) {
        const user = await getCurrentUser(AbortSignal.timeout(15000)).catch((error) => {
          if (error instanceof AuthRequestError && error.status === 401) return null
          throw error
        })
        if (!active) return
        noteBrowserSession(user?.id ?? null)
        if (user && (page === 'home' || page === 'login' || open)) {
          location.replace(`/workbench${location.search}${location.hash}`)
          return
        }
      }
      const pending = await hasPendingSubmission().catch(() => false)
      if (active) {
        if (pending || new URLSearchParams(location.search).has(OAUTH_ERROR_QUERY_PARAM)) onOpen()
        setStatus('ready')
      }
    }
    void boot().catch(() => {
      if (active) setStatus('error')
    })
    return () => {
      active = false
    }
  }, [locale, page, attempt])
  const visible = open || page === 'login'
  if (!visible) return null
  const close = () => {
    void discardPendingSubmission()
    if (page === 'login') location.assign(locale === 'en' ? '/en/' : '/')
    else onClose()
  }
  if (status !== 'ready')
    return (
      <Overlay onClose={close} label={text.loginTitle}>
        <div className="site-auth-status" role="status">
          <p>{status === 'error' ? text.unavailable : text.loading}</p>
          {status === 'error' ? (
            <Button onClick={() => setAttempt((a) => a + 1)}>{text.retry}</Button>
          ) : null}
          <Button variant="ghost" onClick={close}>
            {text.close}
          </Button>
        </div>
      </Overlay>
    )
  return (
    <Suspense
      fallback={
        <Overlay onClose={close} label={text.loginTitle}>
          <div className="site-auth-status" role="status">
            {text.loading}
          </div>
        </Overlay>
      }
    >
      <LoginDialog
        plansHref="/pricing"
        onClose={close}
        presentation={page === 'login' ? 'page' : 'dialog'}
        onAuthenticated={() => location.assign('/workbench?auth_session=1')}
      />
    </Suspense>
  )
}
