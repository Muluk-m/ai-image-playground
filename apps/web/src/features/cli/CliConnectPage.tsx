import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import PageHeader from '../../components/patterns/PageHeader'
import SegmentedTabs from '../../components/patterns/SegmentedTabs'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { currentLocale, i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import {
  AuthRequestError,
  type CliConnectionSummary,
  fetchCliConnections,
} from '../../lib/authClient'
import { copyTextToClipboard } from '../../lib/clipboardText'
import { GUIDE_PATHS } from '../guide/paths'
import CliConnectionsSection from './CliConnectionsSection'
import {
  AGENT_SETUP_PATH,
  CONNECT_AGENTS,
  type ConnectAgentId,
  type ConnectPlatform,
  detectPlatform,
  guideUrl,
  manualCommands,
  SKILL_PACKAGE_PATH,
  skillPackage,
} from './connectAgents'

type CopyState = 'idle' | 'done' | 'failed'

const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 10 * 60 * 1000

const AGENT_LABEL = {
  workbuddy: 'cliConnect.agent.workbuddy',
  doubao: 'cliConnect.agent.doubao',
  'claude-code': 'cliConnect.agent.claude-code',
  codex: 'cliConnect.agent.codex',
  other: 'cliConnect.agent.other',
} as const satisfies Record<ConnectAgentId, `cliConnect.agent.${ConnectAgentId}`>

const SKILL_COPY = {
  workbuddy: {
    title: 'cliConnect.workbuddySkill.title',
    hint: 'cliConnect.workbuddySkill.hint',
    download: 'cliConnect.workbuddySkill.download',
  },
  doubao: {
    title: 'cliConnect.doubaoSkill.title',
    hint: 'cliConnect.doubaoSkill.hint',
    download: 'cliConnect.doubaoSkill.download',
  },
  other: {
    title: 'cliConnect.otherSkill.title',
    hint: 'cliConnect.otherSkill.hint',
    download: 'cliConnect.otherSkill.download',
  },
} as const

/** 品牌标记来自 lobe-icons（MIT），见 public/connect-agents/NOTICE.txt。 */
const FEATURED_AGENTS = [
  { id: 'workbuddy', icon: '/connect-agents/workbuddy.svg' },
  { id: 'doubao', icon: '/connect-agents/doubao.svg' },
  { id: 'codex', icon: '/connect-agents/codex.svg' },
  { id: 'claude-code', icon: '/connect-agents/claude-code.svg' },
] as const

/** 复制按钮：点一次出一次反馈，1.6 秒后复位。 */
function useCopy(onCopied?: () => void) {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | undefined>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      window.clearTimeout(timer.current)
    }
  }, [])
  async function copy(text: string) {
    let result: CopyState = 'done'
    try {
      await copyTextToClipboard(text)
    } catch {
      result = 'failed'
    }
    if (!mounted.current) return
    window.clearTimeout(timer.current)
    setState(result)
    if (result === 'done') onCopied?.()
    timer.current = window.setTimeout(() => setState('idle'), 1600)
  }
  return { state, copy }
}

function CopyButton({
  text,
  label,
  variant = 'outline',
  size = 'sm',
  className,
  onCopied,
}: {
  text: string
  label: string
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm'
  className?: string
  onCopied?: () => void
}) {
  const { t } = useTranslation('auth')
  const { state, copy } = useCopy(onCopied)
  const text_ =
    state === 'done'
      ? t('cliConnect.copied')
      : state === 'failed'
        ? t('cliConnect.copyFailed')
        : label
  return (
    <Button
      type="button"
      size={size}
      variant={state === 'done' && variant === 'outline' ? 'secondary' : variant}
      className={className}
      onClick={() => void copy(text)}
      aria-live="polite"
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} />
      {text_}
    </Button>
  )
}

function CommandBlock({ lines }: { lines: string[] }) {
  return (
    <pre className="whitespace-pre-wrap break-all rounded-xl border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
      {lines.map((line) => (
        <div key={line} className="[&:not(:first-child)]:mt-2">
          {line}
        </div>
      ))}
    </pre>
  )
}

/**
 * 智能体接入页：全宿主共用一条极简消息，由智能体自动识别宿主与系统；
 * 用户复制提示词、复制命令或下载技能包后再后台静默监听新连接，连上后提示并刷新列表；
 * 手动命令与技能包下载收进底部折叠区。
 */
export default function CliConnectPage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [manualOpen, setManualOpen] = useState(false)
  const [agent, setAgent] = useState<ConnectAgentId>('workbuddy')
  const [platform, setPlatform] = useState<ConnectPlatform>(() =>
    detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  )
  const [watchingUserId, setWatchingUserId] = useState<string | null>(null)
  const [connectedDetected, setConnectedDetected] = useState(false)
  const [cliAvailable, setCliAvailable] = useState(true)
  const [connectionsRefreshKey, setConnectionsRefreshKey] = useState(0)
  const listedIdsRef = useRef<Set<string> | null>(null)
  const watchDeadlineRef = useRef(0)
  const isWatching = cliAvailable && watchingUserId !== null && watchingUserId === user?.id

  const recordListedConnections = useCallback((connections: readonly CliConnectionSummary[]) => {
    listedIdsRef.current = new Set(connections.map((connection) => connection.id))
  }, [])

  const handleCliUnavailable = useCallback(() => {
    setCliAvailable(false)
    setWatchingUserId(null)
  }, [])

  const startWatching = useCallback(() => {
    if (!user?.id || !cliAvailable) return
    watchDeadlineRef.current = Date.now() + POLL_TIMEOUT_MS
    setConnectedDetected(false)
    setWatchingUserId(user.id)
  }, [user?.id, cliAvailable])

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('cliConnect.documentTitle', { ns: 'auth' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  useEffect(() => {
    listedIdsRef.current = null
    watchDeadlineRef.current = 0
    setWatchingUserId(null)
    setConnectedDetected(false)
    setCliAvailable(true)
  }, [user?.id])

  // 仅在用户主动复制或下载后后台静默轮询新连接，不展示常驻加载态；
  // 后台标签页暂停轮询，超时、CLI 能力未启用或鉴权失效时自动停止。
  useEffect(() => {
    if (!user?.id || !isWatching) return
    let baselineIds = listedIdsRef.current
    let cancelled = false
    let stopped = false
    let timer: number | undefined
    let expiryTimer: number | undefined
    let activeController: AbortController | null = null

    const stopWatching = () => {
      stopped = true
      window.clearTimeout(timer)
      window.clearTimeout(expiryTimer)
      activeController?.abort()
      if (!cancelled) setWatchingUserId(null)
    }

    const checkExpiry = () => {
      const remaining = watchDeadlineRef.current - Date.now()
      if (remaining <= 0) {
        stopWatching()
        return
      }
      expiryTimer = window.setTimeout(checkExpiry, remaining)
    }

    const schedule = () => {
      if (cancelled || stopped) return
      if (document.visibilityState === 'hidden') return
      timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }

    const poll = async () => {
      if (cancelled || stopped) return
      if (Date.now() >= watchDeadlineRef.current) {
        stopWatching()
        return
      }
      activeController?.abort()
      const controller = new AbortController()
      activeController = controller
      try {
        const list = await fetchCliConnections(controller.signal)
        if (cancelled || controller.signal.aborted) return
        baselineIds ??= listedIdsRef.current
        const baseline = baselineIds
        if (baseline === null) {
          baselineIds = new Set(list.map((item) => item.id))
        } else if (list.some((item) => !baseline.has(item.id))) {
          setConnectedDetected(true)
          setConnectionsRefreshKey((k) => k + 1)
          stopWatching()
          return
        }
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        if (error instanceof AuthRequestError && error.code === 'capability_unavailable') {
          setCliAvailable(false)
          stopWatching()
          return
        }
        if (error instanceof AuthRequestError && (error.status === 401 || error.status === 403)) {
          stopWatching()
          return
        }
      }
      schedule()
    }

    const onVisibility = () => {
      if (cancelled || stopped) return
      window.clearTimeout(timer)
      if (document.visibilityState === 'visible') {
        void poll()
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    checkExpiry()
    void poll()
    return () => {
      cancelled = true
      stopped = true
      window.clearTimeout(timer)
      window.clearTimeout(expiryTimer)
      activeController?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [user?.id, isWatching])

  const setupUrl = useMemo(() => guideUrl(AGENT_SETUP_PATH, window.location.origin), [])
  const universalPrompt = t('cliConnect.universalPrompt', { setupUrl })
  const trySayPrompt = t('cliConnect.trySayPrompt')
  const manual = useMemo(
    () => manualCommands(agent, platform, window.location.origin),
    [agent, platform],
  )
  const pack = skillPackage(agent)

  return (
    <main className="flex h-[calc(100dvh-var(--mobile-nav-height,0px)-var(--mobile-topbar-height,0px)-var(--app-inset,0px)*2)] flex-col bg-background text-foreground">
      <PageHeader title={t('cliConnect.title')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-8 md:px-6">
          <section className="mx-auto flex max-w-2xl flex-col items-center space-y-3 text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
              <img src="/brand/muvloom-mark.svg" alt="" width={14} height={14} />
              {t('cliConnect.eyebrow')}
            </span>
            <h2 className="text-headline font-semibold tracking-tight">{t('cliConnect.hero')}</h2>
            <p className="text-sm text-muted-foreground">{t('cliConnect.subtitle')}</p>
          </section>

          <section
            aria-label={t('cliConnect.setupAria')}
            className="grid gap-6 lg:grid-cols-5 lg:items-start"
          >
            <div className="space-y-4 rounded-2xl border border-border bg-card p-6 lg:col-span-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-body-sm font-semibold text-primary">
                  {t('cliConnect.promptLabel')}
                </span>
                <span className="text-xs text-muted-foreground">{t('cliConnect.promptNote')}</span>
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-border bg-background p-4 sm:flex-row sm:items-center sm:justify-between">
                <p
                  data-slot="connect-prompt"
                  className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground"
                >
                  {universalPrompt}
                </p>
                <CopyButton
                  key={user?.id}
                  text={universalPrompt}
                  label={t('cliConnect.copyMessage')}
                  variant="default"
                  size="default"
                  className="shrink-0"
                  onCopied={startWatching}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4">
                {FEATURED_AGENTS.map((item) => (
                  <span
                    key={item.id}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
                  >
                    <img
                      src={item.icon}
                      alt=""
                      width={16}
                      height={16}
                      className="size-4 shrink-0 object-contain"
                    />
                    {t(AGENT_LABEL[item.id])}
                  </span>
                ))}
                <a
                  href={`${GUIDE_PATHS[currentLocale()]}plugins/cli/`}
                  className="ml-auto inline-flex items-center gap-1 rounded-xs text-xs font-medium text-muted-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('cliConnect.tutorial')}
                  <Icon name="arrowRight" size="xs" />
                </a>
              </div>

              {user && cliAvailable && connectedDetected ? (
                <div
                  role="status"
                  className="flex items-center gap-2.5 rounded-xl bg-primary/15 px-3.5 py-2.5 text-body-sm font-medium text-primary"
                >
                  <Icon name="success" size="sm" className="text-success" />
                  <span>{t('cliConnect.connectedStatus')}</span>
                </div>
              ) : null}

              <div className="pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-expanded={manualOpen}
                  className="px-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                  onClick={() => setManualOpen((open) => !open)}
                >
                  <Icon name={manualOpen ? 'chevronDown' : 'chevronRight'} size="xs" />
                  {t('cliConnect.manualToggle')}
                </Button>

                {manualOpen ? (
                  <div className="mt-3 space-y-4 rounded-xl border border-border bg-background p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <SegmentedTabs
                          label={t('cliConnect.agentAria')}
                          value={agent}
                          onChange={setAgent}
                          tabs={CONNECT_AGENTS.map((id) => ({
                            value: id,
                            label: t(AGENT_LABEL[id]),
                          }))}
                        />
                        <SegmentedTabs
                          label={t('cliConnect.platformAria')}
                          value={platform}
                          onChange={setPlatform}
                          tabs={[
                            { value: 'unix', label: t('cliConnect.platform.unix') },
                            { value: 'windows', label: t('cliConnect.platform.windows') },
                          ]}
                        />
                      </div>
                      <CopyButton
                        key={user?.id}
                        text={manual.join('\n')}
                        label={t('cliConnect.copyCommands')}
                        onCopied={startWatching}
                      />
                    </div>
                    <CommandBlock lines={manual} />
                    {pack ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                        <p className="text-xs text-muted-foreground">{t(SKILL_COPY[pack].hint)}</p>
                        <Button asChild variant="outline" size="sm">
                          <a href={SKILL_PACKAGE_PATH[pack]} download onClick={startWatching}>
                            <Icon name="download" size="xs" />
                            {t(SKILL_COPY[pack].download)}
                          </a>
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="space-y-4 lg:col-span-2">
              <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  {t('cliConnect.nextStepsTitle')}
                </h3>
                <ol className="space-y-4">
                  {[
                    [
                      '01',
                      t('cliConnect.nextSteps.step1Title'),
                      t('cliConnect.nextSteps.step1Body'),
                    ],
                    [
                      '02',
                      t('cliConnect.nextSteps.step2Title'),
                      t('cliConnect.nextSteps.step2Body'),
                    ],
                    [
                      '03',
                      t('cliConnect.nextSteps.step3Title'),
                      t('cliConnect.nextSteps.step3Body'),
                    ],
                  ].map(([index, title, body]) => (
                    <li key={index} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
                      <span className="font-mono text-xs font-semibold text-primary">{index}</span>
                      <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-foreground">{title}</p>
                        <p className="text-body-sm text-muted-foreground">{body}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="space-y-3 rounded-2xl border border-border bg-card p-6">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  {t('cliConnect.trySayTitle')}
                </h3>
                <p className="text-sm font-medium leading-relaxed text-foreground">
                  “{trySayPrompt}”
                </p>
                <CopyButton text={trySayPrompt} label={t('cliConnect.copyTrySay')} />
              </div>
            </div>
          </section>

          {user ? (
            cliAvailable ? (
              <CliConnectionsSection
                key={`${user.id}:${connectionsRefreshKey}`}
                standalone
                onLoaded={recordListedConnections}
                onUnavailable={handleCliUnavailable}
              />
            ) : null
          ) : (
            <section className="space-y-4">
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-8 text-center">
                <p className="text-body-sm text-muted-foreground">{t('cliConnect.signInHint')}</p>
                <Button type="button" variant="outline" onClick={() => promptLogin('gated-action')}>
                  {t('cliDevice.signIn')}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  )
}
