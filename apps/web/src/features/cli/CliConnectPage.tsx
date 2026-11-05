import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { promptLogin } from '../../auth/loginPrompt'
import Badge from '../../components/patterns/Badge'
import PageHeader from '../../components/patterns/PageHeader'
import SegmentedTabs from '../../components/patterns/SegmentedTabs'
import { Button } from '../../components/ui/button'
import { Icon } from '../../components/ui/icon'
import { i18next, setDocumentTitleOverride, useTranslation } from '../../i18n'
import { copyTextToClipboard } from '../../lib/clipboardText'
import { navigate } from '../../lib/pathname'
import { cn } from '../../lib/utils'
import CliConnectionsSection from './CliConnectionsSection'
import {
  CONNECT_AGENTS,
  type ConnectAgentId,
  type ConnectPlatform,
  connectPromptKey,
  detectPlatform,
  INSTALL_COMMAND,
  manualCommands,
  SESSION_PATH,
  skillInstallCommand,
} from './connectAgents'

type CopyState = 'idle' | 'done' | 'failed'
type Mode = 'prompt' | 'manual'

const AGENT_LABEL = {
  workbuddy: 'cliConnect.agent.workbuddy',
  doubao: 'cliConnect.agent.doubao',
  'claude-code': 'cliConnect.agent.claude-code',
  codex: 'cliConnect.agent.codex',
  other: 'cliConnect.agent.other',
} as const satisfies Record<ConnectAgentId, `cliConnect.agent.${ConnectAgentId}`>

/** 品牌标记来自 lobe-icons（MIT），见 public/connect-agents/NOTICE.txt。其他没有品牌标记。 */
const AGENT_ICON: Partial<Record<ConnectAgentId, string>> = {
  workbuddy: '/connect-agents/workbuddy.svg',
  doubao: '/connect-agents/doubao.svg',
  'claude-code': '/connect-agents/claude-code.svg',
  codex: '/connect-agents/codex.svg',
}

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

function CopyButton({ text, label }: { text: string; label: string }) {
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
      size="sm"
      variant={state === 'done' ? 'secondary' : 'outline'}
      onClick={() => void copy(text)}
      aria-live="polite"
    >
      <Icon name={state === 'done' ? 'check' : 'copy'} />
      {text_}
    </Button>
  )
}

function StepHeading({ index, title, hint }: { index: number; title: string; hint?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary/15 text-label-md text-primary"
      >
        {index}
      </span>
      <div className="min-w-0">
        <h2 className="text-title-sm text-foreground">{title}</h2>
        {hint ? <p className="mt-1 text-body-sm text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}

function CommandBlock({ lines }: { lines: string[] }) {
  return (
    <pre className="whitespace-pre-wrap break-all rounded-xl border border-border bg-background px-4 py-3 font-mono text-label-md leading-relaxed text-foreground">
      {lines.map((line) => (
        <div key={line} className="[&:not(:first-child)]:mt-2">
          {line}
        </div>
      ))}
    </pre>
  )
}

/**
 * 插件接入页：选一个宿主，复制一段话发给它，或自己执行安装与授权；回到这里看已连接设备。
 * 全程不替用户操作终端，也不读取任何凭据——授权仍走 `/device` 设备码页。
 */
export default function CliConnectPage() {
  const { t } = useTranslation('auth')
  const user = useAuth().user
  const [agent, setAgent] = useState<ConnectAgentId>('workbuddy')
  const [mode, setMode] = useState<Mode>('prompt')
  const [platform, setPlatform] = useState<ConnectPlatform>(() =>
    detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent),
  )

  useEffect(() => {
    setDocumentTitleOverride(() => i18next.t('cliConnect.documentTitle', { ns: 'auth' }))
    return () => setDocumentTitleOverride(null)
  }, [])

  const skill = skillInstallCommand(agent)
  const prompt = useMemo(
    () =>
      t(connectPromptKey(agent), {
        install: INSTALL_COMMAND[platform],
        path: SESSION_PATH[platform],
        skill: skill ?? '',
      }),
    [t, agent, skill, platform],
  )
  const manual = useMemo(() => manualCommands(agent, platform), [agent, platform])

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <PageHeader
        leading={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('cliConnect.back')}
            onClick={() => navigate('/')}
          >
            <Icon name="back" />
          </Button>
        }
        title={t('cliConnect.title')}
      />

      <div className="mx-auto w-full max-w-3xl space-y-10 px-4 pb-20 pt-10 md:px-6">
        <section className="space-y-3 text-center">
          <h1 className="text-headline font-semibold sm:text-display">{t('cliConnect.hero')}</h1>
          <p className="text-body-md text-muted-foreground">{t('cliConnect.subtitle')}</p>
        </section>

        <section
          aria-label={t('cliConnect.setupAria')}
          className="space-y-6 rounded-3xl border border-border bg-card p-4 md:p-6"
        >
          <div
            role="group"
            aria-label={t('cliConnect.agentAria')}
            className="flex flex-wrap justify-center gap-2"
          >
            {CONNECT_AGENTS.map((id) => {
              const selected = agent === id
              const icon = AGENT_ICON[id]
              return (
                <Button
                  key={id}
                  type="button"
                  variant="ghost"
                  aria-pressed={selected}
                  onClick={() => setAgent(id)}
                  className={cn(
                    'h-auto min-w-16 flex-col gap-1.5 rounded-2xl px-2 py-2 font-normal',
                    selected
                      ? 'bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary'
                      : 'text-muted-foreground',
                  )}
                >
                  {icon ? (
                    <img src={icon} alt="" width={36} height={36} className="size-9" />
                  ) : (
                    <Icon name="grid" size="lg" />
                  )}
                  {t(AGENT_LABEL[id])}
                </Button>
              )
            })}
          </div>

          <div className="space-y-8">
            <div className="space-y-4">
              <StepHeading
                index={1}
                title={t(
                  mode === 'prompt'
                    ? 'cliConnect.step1.promptTitle'
                    : 'cliConnect.step1.manualTitle',
                )}
                hint={t(
                  mode === 'prompt' ? 'cliConnect.step1.promptHint' : 'cliConnect.step1.manualHint',
                )}
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <SegmentedTabs
                    label={t('cliConnect.modeAria')}
                    value={mode}
                    onChange={setMode}
                    tabs={[
                      { value: 'prompt', label: t('cliConnect.mode.prompt') },
                      { value: 'manual', label: t('cliConnect.mode.manual') },
                    ]}
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
                  text={mode === 'prompt' ? prompt : manual.join('\n')}
                  label={t(mode === 'prompt' ? 'cliConnect.copyPrompt' : 'cliConnect.copyCommands')}
                />
              </div>
              {mode === 'prompt' ? (
                <pre
                  data-slot="connect-prompt"
                  className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-background px-4 py-3 text-body-sm leading-relaxed text-foreground"
                >
                  {prompt}
                </pre>
              ) : (
                <CommandBlock lines={manual} />
              )}
            </div>

            <div className="space-y-4">
              <StepHeading
                index={2}
                title={t('cliConnect.step2.title')}
                hint={t('cliConnect.step2.hint')}
              />
              <ol className="space-y-3 text-body-sm text-muted-foreground">
                <li className="flex gap-2">
                  <Icon name="terminal" className="mt-0.5 size-4 shrink-0" />
                  <span>{t('cliConnect.step2.login')}</span>
                </li>
                <li className="flex gap-2">
                  <Icon name="security" className="mt-0.5 size-4 shrink-0" />
                  <span>{t('cliConnect.step2.approve')}</span>
                </li>
                <li className="flex gap-2">
                  <Icon name="check" className="mt-0.5 size-4 shrink-0" />
                  <span>{t('cliConnect.step2.ready')}</span>
                </li>
              </ol>
              <div
                aria-hidden="true"
                className="space-y-3 rounded-2xl border border-dashed border-border bg-background/60 p-4"
              >
                <p className="text-label-md text-muted-foreground">
                  {t('cliConnect.step2.sampleLabel')}
                </p>
                <p className="font-mono text-title-lg tracking-widest text-foreground">BCDF-GHJK</p>
                <div className="flex gap-2">
                  <span className="inline-flex h-8 flex-1 items-center justify-center rounded-md border border-border text-label-md text-muted-foreground">
                    {t('cliDevice.deny')}
                  </span>
                  <span className="inline-flex h-8 flex-1 items-center justify-center rounded-md bg-primary text-label-md text-primary-foreground">
                    {t('cliDevice.approve')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-title-sm">{t('cliConnect.capabilities.title')}</h2>
            <Badge>{t('cliConnect.capabilities.badge')}</Badge>
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {[
              [
                t('cliConnect.capabilities.generate.title'),
                t('cliConnect.capabilities.generate.body'),
              ],
              [
                t('cliConnect.capabilities.reference.title'),
                t('cliConnect.capabilities.reference.body'),
              ],
              [t('cliConnect.capabilities.quote.title'), t('cliConnect.capabilities.quote.body')],
            ].map(([title, body]) => (
              <li key={title} className="space-y-1 rounded-2xl border border-border bg-card p-4">
                <p className="text-title-sm">{title}</p>
                <p className="text-body-sm text-muted-foreground">{body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-title-sm">{t('cliConnections.title')}</h2>
          {user ? (
            <CliConnectionsSection standalone />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-10 text-center">
              <p className="text-body-sm text-muted-foreground">{t('cliConnect.signInHint')}</p>
              <Button type="button" onClick={() => promptLogin('gated-action')}>
                {t('cliDevice.signIn')}
              </Button>
            </div>
          )}
        </section>
      </div>
    </main>
  )
}
