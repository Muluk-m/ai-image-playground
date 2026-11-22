import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
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

function Stepper({
  step,
  showLoginStep,
}: {
  step: 'login' | 'approve' | 'return'
  showLoginStep: boolean
}) {
  const { t } = useTranslation('auth')
  const items = showLoginStep
    ? ([
        { id: 'login', label: t('cliDevice.steps.login') },
        { id: 'approve', label: t('cliDevice.steps.approve') },
        { id: 'return', label: t('cliDevice.steps.return') },
      ] as const)
    : ([
        { id: 'approve', label: t('cliDevice.steps.approve') },
        { id: 'return', label: t('cliDevice.steps.return') },
      ] as const)
  const activeIndex = items.findIndex((item) => item.id === step)

  return (
    <nav aria-label={t('cliDevice.stepperAria')} className="flex items-center gap-2.5 text-body-sm">
      {items.map((item, idx) => {
        const done = idx < activeIndex || (step === 'return' && item.id === 'return')
        const active = idx === activeIndex && !done
        return (
          <div key={item.id} className="flex items-center gap-2.5">
            {idx > 0 ? (
              <span
                aria-hidden="true"
                className={`h-0.5 w-8 rounded-full ${idx <= activeIndex ? 'bg-primary' : 'bg-border'}`}
              />
            ) : null}
            <div
              className={`flex items-center gap-2 ${
                active || done ? 'font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span
                aria-hidden="true"
                className={`grid size-5 place-items-center rounded-full border text-label-sm ${
                  done || active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card text-muted-foreground'
                }`}
              >
                {done ? <Icon name="check" size="xs" /> : idx + 1}
              </span>
              <span>{item.label}</span>
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function BridgeVisual({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-3" aria-hidden="true">
      <div className="grid size-12 place-items-center rounded-xl border border-border bg-background text-foreground">
        <Icon name="terminal" size="md" />
      </div>
      <span
        className={`w-8 border-t-2 border-dashed ${active ? 'border-primary' : 'border-border'}`}
      />
      <div
        className={`grid size-12 place-items-center rounded-xl border bg-secondary ${
          active ? 'border-primary/40' : 'border-border'
        }`}
      >
        <img src="/brand/muvloom-mark.svg" alt="" width={24} height={24} />
      </div>
    </div>
  )
}

/**
 * CLI / 智能体设备授权确认页（RFC 8628）。
 * 已登录用户直接进入授权确认（跳过步骤 1），未登录用户先走登录再无缝回到确认态。
 * 能力以易读胶囊呈现，详细 scope 折叠在「查看所有权限」内；全页唯一主按钮为「允许」。
 */
export default function CliDevicePage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [code, setCode] = useState(codeFromAddress)
  const [draft, setDraft] = useState(code)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [scopesOpen, setScopesOpen] = useState(false)
  const [startedSignedOut] = useState(() => !user)
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

  // URL 已带授权码且未登录时自动打开登录框，减少一次额外点击。
  const autoPrompted = useRef(false)
  useEffect(() => {
    if (user || !code || outcome) {
      autoPrompted.current = false
      return
    }
    if (autoPrompted.current) return
    autoPrompted.current = true
    promptLogin('gated-action')
  }, [user, code, outcome])

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

  const showLoginStep = startedSignedOut || !user
  const currentStep: 'login' | 'approve' | 'return' =
    outcome === 'connected' || phase.kind === 'approved' || phase.kind === 'returning'
      ? 'return'
      : !user
        ? 'login'
        : 'approve'

  const accountLabel = user?.nickname?.trim() || user?.username || ''
  const accountInitial = (accountLabel.slice(0, 1) || 'M').toUpperCase()
  const showStepper =
    outcome !== 'failed' &&
    phase.kind !== 'denied' &&
    phase.kind !== 'invalid' &&
    phase.kind !== 'failed'

  const pendingScopes = phase.kind === 'pending' ? phase.authorization.scopes : []
  const capabilityTags = [
    ...(pendingScopes.includes('images:write') ? [t('cliDevice.capabilities.generate')] : []),
    ...(pendingScopes.includes('media:write') ? [t('cliDevice.capabilities.reference')] : []),
    ...(pendingScopes.includes('images:read') || pendingScopes.includes('media:read')
      ? [t('cliDevice.capabilities.jobs')]
      : []),
  ]
  const unknownScopes = pendingScopes.filter((scope) => !(scope in scopeLabels))
  const spendsCredits = pendingScopes.includes('images:write')

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-8 text-foreground">
      {showStepper ? <Stepper step={currentStep} showLoginStep={showLoginStep} /> : null}

      <section className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-dialog sm:p-8">
        {outcome && !code ? (
          <div className="flex flex-col items-center space-y-4 text-center">
            <div
              className={`grid size-12 place-items-center rounded-full ${
                outcome === 'connected'
                  ? 'bg-primary/15 text-success'
                  : 'bg-destructive/15 text-destructive'
              }`}
              aria-hidden="true"
            >
              <Icon name={outcome === 'connected' ? 'check' : 'error'} size="md" />
            </div>
            <h1 className="text-xl font-semibold">
              {t(outcome === 'connected' ? 'cliDevice.approvedHeading' : 'cliDevice.title')}
            </h1>
            <p
              className={
                outcome === 'connected'
                  ? 'text-body-sm text-muted-foreground'
                  : 'text-body-sm text-destructive'
              }
              role={outcome === 'connected' ? 'status' : 'alert'}
            >
              {t(outcome === 'connected' ? 'cliDevice.connected' : 'cliDevice.notFinished')}
            </p>
          </div>
        ) : !code ? (
          <div className="space-y-6">
            <div className="space-y-4 text-center">
              <BridgeVisual active={false} />
              <h1 className="text-xl font-semibold">{t('cliDevice.manualCodeHeading')}</h1>
            </div>
            <form className="space-y-3" onSubmit={submitCode}>
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="XXXX-XXXX"
                aria-label={t('cliDevice.codeLabel')}
                autoComplete="one-time-code"
                className="text-center font-mono uppercase tracking-widest"
              />
              <Button type="submit" className="w-full" disabled={!draft.trim()}>
                {t('cliDevice.continue')}
              </Button>
            </form>
          </div>
        ) : !user ? (
          <div className="space-y-6 text-center">
            <BridgeVisual active={false} />
            <div className="space-y-2">
              <h1 className="text-xl font-semibold">{t('cliDevice.loginHeading')}</h1>
              <p className="text-body-sm text-muted-foreground">{t('cliDevice.loginSubtitle')}</p>
            </div>
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={() => promptLogin('gated-action')}
            >
              {t('cliDevice.signIn')}
            </Button>
          </div>
        ) : phase.kind === 'pending' ? (
          <div className="space-y-6">
            <div className="flex flex-col items-center space-y-3 text-center">
              <BridgeVisual active />
              <h1 className="text-xl font-semibold">{t('cliDevice.approveHeading')}</h1>
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 font-mono text-xs text-muted-foreground">
                <Icon name="terminal" size="xs" />
                {phase.authorization.client_name}
              </span>
            </div>

            <div className="space-y-3 border-t border-border pt-5">
              <p className="text-xs text-muted-foreground">{t('cliDevice.capabilitiesLabel')}</p>
              {capabilityTags.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {capabilityTags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-secondary px-3 py-1 text-body-sm font-medium text-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              {spendsCredits ? (
                <p className="text-xs text-muted-foreground">{t('cliDevice.creditsNotice')}</p>
              ) : null}
              {unknownScopes.length > 0 ? (
                <ul className="space-y-1 rounded-xl border border-border bg-background px-3.5 py-2 text-xs text-foreground">
                  {unknownScopes.map((scope) => (
                    <li key={scope} className="font-mono">
                      {scope}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-expanded={scopesOpen}
                  className="px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  onClick={() => setScopesOpen((open) => !open)}
                >
                  <Icon name={scopesOpen ? 'chevronDown' : 'chevronRight'} size="xs" />
                  {t('cliDevice.viewAllPermissions')}
                </Button>
                {scopesOpen ? (
                  <ul className="mt-2 space-y-1.5 rounded-xl border border-border bg-background px-3.5 py-2.5 text-xs text-muted-foreground">
                    {phase.authorization.scopes.map((scope) => (
                      <li key={scope}>{scopeLabels[scope] ?? scope}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>

            {accountLabel ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2.5 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-label-sm font-semibold text-primary">
                    {accountInitial}
                  </span>
                  <span className="truncate font-medium text-foreground">{accountLabel}</span>
                </div>
                <span className="shrink-0 text-muted-foreground">
                  {t('cliDevice.currentAccount')}
                </span>
              </div>
            ) : null}

            <div className="space-y-2">
              <Button type="button" size="lg" className="w-full" onClick={() => decide('approve')}>
                {t('cliDevice.approve')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground hover:text-destructive"
                onClick={() => decide('deny')}
              >
                {t('cliDevice.deny')}
              </Button>
            </div>
          </div>
        ) : phase.kind === 'loading' || phase.kind === 'returning' ? (
          <div className="flex flex-col items-center space-y-4 py-6 text-center">
            <BridgeVisual active />
            <p
              className="inline-flex items-center gap-2 text-body-sm text-muted-foreground"
              aria-live="polite"
            >
              <Icon name="loading" size="sm" className="animate-spin text-primary" />
              {t('cliDevice.working')}
            </p>
          </div>
        ) : phase.kind === 'approved' ? (
          <div className="flex flex-col items-center space-y-4 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-primary/15 text-success">
              <Icon name="check" size="md" />
            </div>
            <h1 className="text-xl font-semibold">{t('cliDevice.approvedHeading')}</h1>
            <p className="text-body-sm text-muted-foreground" role="status">
              {t('cliDevice.approved')}
            </p>
            <p className="text-body-sm text-muted-foreground">{t('cliDevice.approvedHint')}</p>
            <Button type="button" variant="outline" className="w-full" onClick={closePage}>
              {t('cliDevice.return')}
            </Button>
            {closeBlocked ? (
              <p className="text-body-sm text-muted-foreground" aria-live="polite">
                {t('cliDevice.closeManually')}
              </p>
            ) : null}
          </div>
        ) : phase.kind === 'denied' ? (
          <div className="flex flex-col items-center space-y-3 py-2 text-center">
            <h1 className="text-xl font-semibold">{t('cliDevice.deniedHeading')}</h1>
            <p className="text-body-sm text-muted-foreground" role="status">
              {t('cliDevice.denied')}
            </p>
          </div>
        ) : phase.kind === 'invalid' || phase.kind === 'failed' ? (
          <div className="flex flex-col items-center space-y-4 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-destructive/15 text-destructive">
              <Icon name="error" size="md" />
            </div>
            <p className="text-body-sm text-destructive" role="alert">
              {t(phase.kind === 'invalid' ? 'cliDevice.invalid' : 'cliDevice.failed')}
            </p>
            {phase.kind === 'failed' && user ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setAttempt((n) => n + 1)}
              >
                {t('cliDevice.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  )
}
