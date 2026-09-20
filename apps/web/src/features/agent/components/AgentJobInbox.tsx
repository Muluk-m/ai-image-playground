import { ChevronRight, ListChecks } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE, INK, INK_3, LIST_ROW } from '../agentStyles'
import { agentCanvasSink } from '../lib/canvasSink'
import { agentJobInbox, agentToolProgress } from '../lib/jobProgress'
import { agentToolFailureText } from '../lib/toolFailure'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import { AgentJobCancel, useAgentJobProgressText, useAgentToolProgress } from './AgentJobProgress'

/**
 * 点一行就把镜头带到它在画布上的那一处：结束了的是产物，还在跑的是它占的位。
 * 本地项目刷新或换设备后，在跑的任务要等交付才重新占位；这时退到它贴着的那个画布对象。
 */
function locate(message: AgentToolMessage): void {
  const sink = agentCanvasSink()
  if (!sink) return
  if (message.status === 'submitted') {
    const found = sink.focusPending?.({
      messageId: message.id,
      ...(message.job ? { taskId: message.job.taskId } : {}),
    })
    if (!found && message.anchorObjectId) sink.focus([message.anchorObjectId])
    return
  }
  sink.focus((message.artifacts ?? []).map((artifact) => artifact.artifactId))
}

function useOutcomeText(message: AgentToolMessage): string {
  const { t } = useTranslation('agent')
  const progress = useAgentToolProgress(message)
  const running = useAgentJobProgressText(progress)
  if (running) return running
  // 重试队列里排着：前一条重试结束后才提交，还没有任务可言。
  if (message.status === 'queued') return t('retry.queued')
  if (message.status === 'succeeded') return t('job.inbox.succeeded')
  if (message.errorCode === 'cancelled') return t('job.cancelled')
  return agentToolFailureText(message.errorCode) ?? t('job.inbox.failed')
}

/**
 * 这批活儿走到哪儿了：已完成一段、没成的一段，余下留给还在跑的那几个，跑着就一直呼吸。
 * 两个裸计数说不清进度，一条走满的杠看得见。
 */
function InboxProgress({
  completed,
  failed,
  running,
}: {
  completed: number
  failed: number
  running: number
}) {
  const total = completed + failed + running
  return (
    <span
      aria-hidden="true"
      className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border"
    >
      {completed > 0 && (
        <span className="bg-primary" style={{ width: `${(completed / total) * 100}%` }} />
      )}
      {failed > 0 && (
        <span className="bg-destructive" style={{ width: `${(failed / total) * 100}%` }} />
      )}
      {running > 0 && <span className="flex-1 animate-pulse bg-primary/40" />}
    </span>
  )
}

function InboxRow({ message, onLocate }: { message: AgentToolMessage; onLocate: () => void }) {
  const { t } = useTranslation('agent')
  const outcome = useOutcomeText(message)
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        title={t('job.inbox.locate')}
        className={`${LIST_ROW} min-w-0 flex-1 flex-col !items-start !gap-0.5`}
        onClick={() => {
          locate(message)
          onLocate()
        }}
      >
        <span className={`w-full truncate ${INK}`}>{message.title}</span>
        <span className={`${CARD_NOTE} tabular-nums`}>{outcome}</span>
      </button>
      <AgentJobCancel message={message} />
    </li>
  )
}

/** 一组任务：标题带个数，点标题收起展开。空组也留着，让人看见「排队中（0）」。 */
function InboxGroup({
  label,
  messages,
  onLocate,
}: {
  label: string
  messages: readonly AgentToolMessage[]
  onLocate: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="pt-0.5">
      <button
        type="button"
        aria-expanded={open}
        disabled={messages.length === 0}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] transition-colors ${INK_3} enabled:hover:bg-muted disabled:opacity-60`}
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open && messages.length > 0 ? 'rotate-90' : ''}`}
          aria-hidden="true"
        />
        <span>
          {label}（{messages.length}）
        </span>
      </button>
      {open && messages.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {messages.map((message) => (
            <InboxRow key={message.id} message={message} onLocate={onLocate} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 画布右上角的后台任务入口：一颗按钮说这批活儿走到哪儿了，点开分「进行中 / 已完成」两页，
 * 进行中再拆成「处理中 / 排队中」，点一行把镜头带过去并收起弹层，点画布或 Esc 也收起。
 * 挂在画布上而不是对话顶上：任务结果落的是画布。数据全来自会话消息与服务端进度，
 * 刷新、换设备后是同一份。
 */
export default function AgentJobInbox() {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const jobProgress = useAgentStore((state) => state.jobProgress)
  const inbox = useMemo(() => agentJobInbox(messages), [messages])
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'running' | 'finished'>('running')
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  // 在跑的分两拨：上游真在画的是处理中，还等在队列里（本机重试队列或服务端排队）的是排队中。
  const { processing, queued } = useMemo(() => {
    const processing: AgentToolMessage[] = []
    const queued: AgentToolMessage[] = []
    for (const message of inbox.running) {
      const phase = agentToolProgress(message, jobProgress[message.id])?.phase
      if (phase === undefined || phase === 'submitted' || phase === 'queued') queued.push(message)
      else processing.push(message)
    }
    return { processing, queued }
  }, [inbox.running, jobProgress])
  const total = inbox.running.length + inbox.finished.length
  if (total === 0) return null
  const label =
    inbox.failed > 0
      ? t('job.inbox.summaryFailed', {
          running: inbox.running.length,
          completed: inbox.completed,
          failed: inbox.failed,
        })
      : t('job.inbox.summary', { running: inbox.running.length, completed: inbox.completed })
  const count = t('job.inbox.count', { done: inbox.finished.length, total })
  const finished = [...inbox.finished].reverse()
  const shown = tab === 'running' ? inbox.running.length : finished.length
  return (
    <div ref={host} className="pointer-events-auto flex flex-col items-end">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => {
          setOpen((value) => !value)
          setTab(inbox.running.length > 0 ? 'running' : 'finished')
        }}
        className={`flex items-center gap-2 rounded-full border border-border bg-sidebar px-3 py-1.5 text-[11px] shadow-lg backdrop-blur transition-colors ${INK} hover:border-primary/40`}
      >
        <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('job.inbox.title')}</span>
        {inbox.running.length > 0 && (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
        <span className={`tabular-nums ${INK_3}`}>{count}</span>
      </button>
      {open && (
        <div className="mt-1.5 w-80 max-w-[85vw] rounded-xl border border-border bg-sidebar p-2.5 shadow-xl">
          <p className={`text-xs font-semibold ${INK}`}>{t('job.inbox.title')}</p>
          <p className={`mt-0.5 text-[11px] ${INK_3}`}>{t('job.inbox.subtitle')}</p>
          <div className="mt-2 flex items-center gap-2">
            <InboxProgress
              completed={inbox.completed}
              failed={inbox.failed}
              running={inbox.running.length}
            />
            <span className={`shrink-0 text-[11px] tabular-nums ${INK_3}`}>{count}</span>
          </div>
          <div role="tablist" className="mt-2 flex gap-1 rounded-lg bg-muted p-0.5">
            {(['running', 'finished'] as const).map((one) => (
              <button
                key={one}
                type="button"
                role="tab"
                aria-selected={tab === one}
                onClick={() => setTab(one)}
                className={`flex-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
                  tab === one ? `bg-sidebar font-semibold ${INK} shadow-sm` : INK_3
                }`}
              >
                {one === 'running'
                  ? `${t('job.inbox.tabRunning')}（${inbox.running.length}）`
                  : `${t('job.inbox.tabFinished')}（${finished.length}）`}
              </button>
            ))}
          </div>
          <div className="mt-1 max-h-64 overflow-y-auto">
            {tab === 'running' ? (
              <>
                <InboxGroup
                  label={t('job.inbox.groupProcessing')}
                  messages={processing}
                  onLocate={() => setOpen(false)}
                />
                <InboxGroup
                  label={t('job.inbox.groupQueued')}
                  messages={queued}
                  onLocate={() => setOpen(false)}
                />
              </>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {finished.map((message) => (
                  <InboxRow key={message.id} message={message} onLocate={() => setOpen(false)} />
                ))}
              </ul>
            )}
            {shown === 0 && tab === 'finished' && (
              <p className={`px-1.5 py-2 text-[11px] ${INK_3}`}>{t('job.inbox.empty')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
