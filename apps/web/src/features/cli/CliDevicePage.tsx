import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { authenticatedBffFetch } from '../../lib/authClient'
import { bffBaseUrl } from '../../lib/runtimeConfig'

interface PendingAuthorization {
  client_name: string
  scopes: string[]
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'pending'; authorization: PendingAuthorization }
  | { kind: 'invalid' }
  | { kind: 'approved' }
  | { kind: 'denied' }
  | { kind: 'failed' }

function codeFromAddress(): string {
  if (typeof window === 'undefined') return ''
  return new URL(window.location.href).searchParams.get('user_code') ?? ''
}

/**
 * CLI 设备授权确认页（RFC 8628）。终端打印的链接带着授权码落到这里；没登录先走网站登录，
 * 登录框关掉后仍停在这一页。批准或拒绝只改这一个授权码，结果由终端轮询取走。
 */
export default function CliDevicePage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [code, setCode] = useState(codeFromAddress)
  const [draft, setDraft] = useState(code)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const deciding = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const scopeLabels: Record<string, string> = {
    'images:read': t('cliDevice.scopes.imagesRead'),
    'images:write': t('cliDevice.scopes.imagesWrite'),
    'media:read': t('cliDevice.scopes.mediaRead'),
    'media:write': t('cliDevice.scopes.mediaWrite'),
  }

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('cliDevice.documentTitle', { ns: 'auth' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  useEffect(() => {
    if (!user || !code) return
    const controller = new AbortController()
    deciding.current = false
    setPhase({ kind: 'loading' })
    // 换了授权码时旧请求可能已在路上：只让这一次的结果写状态，免得页面显示别的客户端权限。
    authenticatedBffFetch(`${bffBaseUrl()}/api/cli/device?user_code=${encodeURIComponent(code)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const authorization: PendingAuthorization | null = res.ok ? await res.json() : null
        if (controller.signal.aborted) return
        if (authorization) setPhase({ kind: 'pending', authorization })
        else setPhase({ kind: res.status === 404 ? 'invalid' : 'failed' })
      })
      .catch(() => {
        if (!controller.signal.aborted) setPhase({ kind: 'failed' })
      })
    return () => controller.abort()
  }, [user, code, attempt])

  async function decide(decision: 'approve' | 'deny') {
    // 同一帧里的连点读到的都是 pending，用 ref 保证只发出第一个决定。
    if (deciding.current || phase.kind !== 'pending') return
    deciding.current = true
    setPhase({ kind: 'loading' })
    try {
      const res = await authenticatedBffFetch(`${bffBaseUrl()}/api/cli/device`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_code: code, decision }),
      })
      if (res.ok) setPhase({ kind: decision === 'approve' ? 'approved' : 'denied' })
      else setPhase({ kind: res.status === 404 ? 'invalid' : 'failed' })
    } catch {
      setPhase({ kind: 'failed' })
    } finally {
      // 失败后可以重试；成功后页面已经没有可点的按钮。
      deciding.current = false
    }
  }

  function submitCode(event: FormEvent) {
    event.preventDefault()
    const next = draft.trim()
    if (!next) return
    const url = new URL(window.location.href)
    url.searchParams.set('user_code', next)
    window.history.replaceState(null, '', `${url.pathname}${url.search}`)
    setCode(next)
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <header className="flex items-center gap-2 font-semibold">
          <img src="/brand/muvloom-mark.svg" alt="" width={24} height={24} />
          <h1 className="text-title-lg">{t('cliDevice.title')}</h1>
        </header>

        {!code ? (
          <form className="space-y-3" onSubmit={submitCode}>
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="XXXX-XXXX"
              aria-label={t('cliDevice.codeLabel')}
              autoComplete="one-time-code"
              className="font-mono uppercase tracking-widest"
            />
            <Button type="submit" className="w-full" disabled={!draft.trim()}>
              {t('cliDevice.continue')}
            </Button>
          </form>
        ) : (
          <p className="font-mono text-headline tracking-widest">{code.toUpperCase()}</p>
        )}

        {code && !user ? (
          <Button type="button" className="w-full" onClick={() => promptLogin('gated-action')}>
            {t('cliDevice.signIn')}
          </Button>
        ) : null}

        {phase.kind === 'pending' ? (
          <div className="space-y-5">
            <div className="space-y-2">
              <p className="text-title-md">{phase.authorization.client_name}</p>
              <ul className="space-y-1 text-body-sm text-muted-foreground">
                {phase.authorization.scopes.map((scope) => (
                  <li key={scope}>{scopeLabels[scope] ?? scope}</li>
                ))}
              </ul>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                className="flex-1"
                onClick={() => decide('deny')}
              >
                {t('cliDevice.deny')}
              </Button>
              <Button type="button" className="flex-1" onClick={() => decide('approve')}>
                {t('cliDevice.approve')}
              </Button>
            </div>
          </div>
        ) : null}

        {phase.kind === 'loading' ? (
          <p className="text-body-sm text-muted-foreground" aria-live="polite">
            {t('cliDevice.working')}
          </p>
        ) : null}
        {phase.kind === 'approved' ? (
          <p className="text-title-md" role="status">
            {t('cliDevice.approved')}
          </p>
        ) : null}
        {phase.kind === 'denied' ? (
          <p className="text-title-md" role="status">
            {t('cliDevice.denied')}
          </p>
        ) : null}
        {phase.kind === 'invalid' || phase.kind === 'failed' ? (
          <p className="text-body-sm text-destructive" role="alert">
            {t(phase.kind === 'invalid' ? 'cliDevice.invalid' : 'cliDevice.failed')}
          </p>
        ) : null}
        {phase.kind === 'failed' && user ? (
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => setAttempt((n) => n + 1)}
          >
            {t('cliDevice.retry')}
          </Button>
        ) : null}
      </section>
    </main>
  )
}
