import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { authenticatedBffFetch } from '../../lib/authClient'
import { bffBaseUrl } from '../../lib/runtimeConfig'
import { leaveTo, loopbackStateFromAddress, loopbackTarget } from './loopbackRedirect'

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
  | { kind: 'returning' }
  | { kind: 'denied' }
  | { kind: 'failed' }

/** CLI 换完令牌后把浏览器带回这里：`connected` 已连接，`failed` 没完成、结果在 CLI 那边。 */
function outcomeFromAddress(): 'connected' | 'failed' | null {
  if (typeof window === 'undefined') return null
  const status = new URL(window.location.href).searchParams.get('status')
  return status === 'connected' || status === 'failed' ? status : null
}

function codeFromAddress(): string {
  if (typeof window === 'undefined') return ''
  return new URL(window.location.href).searchParams.get('user_code') ?? ''
}

/**
 * CLI 设备授权确认页（RFC 8628）。客户端打开的链接带着授权码落到这里；没登录先走网站登录，
 * 登录框关掉后仍停在这一页。批准或拒绝只改这一个授权码，结果由授权客户端轮询取走。
 */
export default function CliDevicePage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [code, setCode] = useState(codeFromAddress)
  const [draft, setDraft] = useState(code)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const deciding = useRef(false)
  const request = useRef<AbortController | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [closeBlocked, setCloseBlocked] = useState(false)
  const [outcome] = useState(outcomeFromAddress)
  // 只有 CLI 在本机打开的链接带 state；手输授权码（可能在另一台设备上）照旧等 CLI 轮询。
  const [loopbackState] = useState(loopbackStateFromAddress)
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
    const restoreCode = () => {
      const next = codeFromAddress()
      setCode(next)
      setDraft(next)
    }
    window.addEventListener('popstate', restoreCode)
    return () => window.removeEventListener('popstate', restoreCode)
  }, [])

  useEffect(() => {
    deciding.current = false
    setCloseBlocked(false)
    if (!user?.id || !code) {
      request.current = null
      setPhase({ kind: 'idle' })
      return
    }
    const controller = new AbortController()
    request.current = controller
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
  }, [user?.id, code, attempt])

  async function decide(decision: 'approve' | 'deny') {
    // 同一帧里的连点读到的都是 pending，用 ref 保证只发出第一个决定。
    const controller = request.current
    if (
      !user ||
      deciding.current ||
      phase.kind !== 'pending' ||
      !controller ||
      controller.signal.aborted
    )
      return
    deciding.current = true
    setPhase({ kind: 'loading' })
    try {
      const res = await authenticatedBffFetch(`${bffBaseUrl()}/api/cli/device`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          loopbackState && decision === 'approve'
            ? { user_code: code, decision, loopback: true }
            : { user_code: code, decision },
        ),
      })
      if (controller.signal.aborted) return
      if (!res.ok) {
        setPhase({ kind: res.status === 404 ? 'invalid' : 'failed' })
        return
      }
      const result: { redirect_to?: unknown } = await res.json().catch(() => ({}))
      const target =
        decision === 'approve' && loopbackState
          ? loopbackTarget(result.redirect_to, loopbackState)
          : null
      if (target) {
        setPhase({ kind: 'returning' })
        leaveTo(target)
        return
      }
      setPhase({ kind: decision === 'approve' ? 'approved' : 'denied' })
    } catch {
      if (!controller.signal.aborted) setPhase({ kind: 'failed' })
    } finally {
      // 旧请求不能解锁新授权码的提交。
      if (!controller.signal.aborted) deciding.current = false
    }
  }

  function closePage() {
    window.close()
    if (!window.closed) setCloseBlocked(true)
  }

  function submitCode(event: FormEvent) {
    event.preventDefault()
    const next = draft.trim()
    if (!next) return
    const url = new URL(window.location.href)
    url.searchParams.set('user_code', next)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    setCode(next)
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5 text-foreground">
      <section className="w-full max-w-sm space-y-6">
        <header className="flex items-center gap-2 font-semibold">
          <img src="/brand/muvloom-mark.svg" alt="" width={24} height={24} />
          <h1 className="text-title-lg">{t('cliDevice.title')}</h1>
        </header>

        {outcome && !code ? (
          // CLI 用系统命令打开的标签页，脚本关不掉：这里只说明结果，不放按不动的按钮。
          <p
            className={outcome === 'connected' ? 'text-title-md' : 'text-body-sm text-destructive'}
            role={outcome === 'connected' ? 'status' : 'alert'}
          >
            {t(outcome === 'connected' ? 'cliDevice.connected' : 'cliDevice.notFinished')}
          </p>
        ) : !code ? (
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

        {code && !user && !outcome ? (
          <Button type="button" className="w-full" onClick={() => promptLogin('gated-action')}>
            {t('cliDevice.signIn')}
          </Button>
        ) : null}

        {user && phase.kind === 'pending' ? (
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

        {phase.kind === 'loading' || phase.kind === 'returning' ? (
          <p className="text-body-sm text-muted-foreground" aria-live="polite">
            {t('cliDevice.working')}
          </p>
        ) : null}
        {phase.kind === 'approved' ? (
          <div className="space-y-3">
            <p className="text-title-md" role="status">
              {t('cliDevice.approved')}
            </p>
            <Button type="button" className="w-full" onClick={closePage}>
              {t('cliDevice.return')}
            </Button>
            {closeBlocked ? (
              <p className="text-body-sm text-muted-foreground" aria-live="polite">
                {t('cliDevice.closeManually')}
              </p>
            ) : null}
          </div>
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
