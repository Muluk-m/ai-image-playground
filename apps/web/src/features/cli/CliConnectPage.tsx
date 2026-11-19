import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import PageHeader from '../../components/patterns/PageHeader'
import SegmentedTabs from '../../components/patterns/SegmentedTabs'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { currentLocale, i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { fetchCliConnections } from '../../lib/authClient'
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
function useCopy() {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  async function copy(text: string) {
    let result: CopyState = 'done'
    try {
      await copyTextToClipboard(text)
    } catch {
      result = 'failed'
    }
    window.clearTimeout(timer.current)
    setState(result)
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
}: {
  text: string
  label: string
  variant?: 'default' | 'outline'
  size?: 'default' | 'sm'
  className?: string
}) {
  const { t } = useTranslation('auth')
  const { state, copy } = useCopy()
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
 * 实时轮询新连接并在连上后自动提示；手动命令与技能包下载收进底部折叠区。
 */
export default function CliConnectPage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [manualOpen, setManualOpen] = useState(false)
  const [agent, setAgent] = useState<ConnectAgentId>('workbuddy')
  const [platform, setPlatform] = useState<ConnectPlatform>(() =>
    detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  )
  const [connectedDetected, setConnectedDetected] = useState(false)
  const [connectionsRefreshKey, setConnectionsRefreshKey] = useState(0)
  const baselineIdsRef = useRef<Set<string> | null>(null)

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('cliConnect.documentTitle', { ns: 'auth' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  // 已登录时静默轮询连接列表，检测到新授权的智能体后自动更新等待提示并刷新列表。
  useEffect(() => {
    baselineIdsRef.current = null
    setConnectedDetected(false)
    if (!user?.id) return
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const list = await fetchCliConnections()
        if (cancelled) return
        if (baselineIdsRef.current === null) {
          baselineIdsRef.current = new Set(list.map((item) => item.id))
        } else if (list.some((item) => !baselineIdsRef.current!.has(item.id))) {
          baselineIdsRef.current = new Set(list.map((item) => item.id))
          setConnectedDetected(true)
          setConnectionsRefreshKey((k) => k + 1)
          return
        }
      } catch {
        // 静默忽略短暂轮询失败，下次继续。
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 4000)
    }
    void poll()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [user?.id])

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
                  text={universalPrompt}
                  label={t('cliConnect.copyMessage')}
                  variant="default"
                  size="default"
                  className="shrink-0 rounded-full"
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
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:underline"
                >
                  {t('cliConnect.tutorial')}
                  <Icon name="arrowRight" size="xs" />
                </a>
              </div>

              {user ? (
                <div
                  role="status"
                  className={`flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-body-sm ${
                    connectedDetected
                      ? 'bg-primary/15 font-medium text-primary'
                      : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  <Icon
                    name={connectedDetected ? 'success' : 'loading'}
                    size="sm"
                    className={connectedDetected ? 'text-success' : 'animate-spin text-primary'}
                  />
                  <span>
                    {t(
                      connectedDetected ? 'cliConnect.connectedStatus' : 'cliConnect.waitingStatus',
                    )}
                  </span>
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
                      <CopyButton text={manual.join('\n')} label={t('cliConnect.copyCommands')} />
                    </div>
                    <CommandBlock lines={manual} />
                    {pack ? (
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                        <p className="text-xs text-muted-foreground">{t(SKILL_COPY[pack].hint)}</p>
                        <Button asChild variant="outline" size="sm">
                          <a href={SKILL_PACKAGE_PATH[pack]} download>
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
                  {(
                    [
                      ['01', 'step1Title', 'step1Body'],
                      ['02', 'step2Title', 'step2Body'],
                      ['03', 'step3Title', 'step3Body'],
                    ] as const
                  ).map(([index, titleKey, bodyKey]) => (
                    <li key={index} className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
                      <span className="font-mono text-xs font-semibold text-primary">{index}</span>
                      <div className="space-y-0.5">
                        <p className="text-sm font-semibold text-foreground">
                          {t(`cliConnect.nextSteps.${titleKey}`)}
                        </p>
                        <p className="text-body-sm text-muted-foreground">
                          {t(`cliConnect.nextSteps.${bodyKey}`)}
                        </p>
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

          <section className="space-y-4">
            {user ? (
              <div className="rounded-2xl border border-border bg-card p-6">
                <CliConnectionsSection key={connectionsRefreshKey} standalone />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-8 text-center">
                <p className="text-body-sm text-muted-foreground">{t('cliConnect.signInHint')}</p>
                <Button type="button" variant="outline" onClick={() => promptLogin('gated-action')}>
                  {t('cliDevice.signIn')}
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
