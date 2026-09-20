import { ListChecks } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE, INK, INK_3, LIST_ROW } from '../agentStyles'
import { agentCanvasSink } from '../lib/canvasSink'
import { agentJobInbox } from '../lib/jobProgress'
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

/**
 * 画布右上角的后台任务入口：一颗按钮说这批活儿走到哪儿了，点开是逐个任务，点一行把镜头带过去，
 * 在跑的能单独取消。挂在画布上而不是对话顶上：任务结果落的是画布，定位过去之后弹层就收起，
 * 不像常驻横条那样一直压着对话。数据全来自会话消息与服务端进度，刷新、换设备后是同一份。
 */
export default function AgentJobInbox() {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const inbox = useMemo(() => agentJobInbox(messages), [messages])
  const [open, setOpen] = useState(false)
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
  const total = inbox.running.length + inbox.finished.length
  if (total === 0) return null
  const rows = [...inbox.running, ...[...inbox.finished].reverse()]
  const label =
    inbox.failed > 0
      ? t('job.inbox.summaryFailed', {
          running: inbox.running.length,
          completed: inbox.completed,
          failed: inbox.failed,
        })
      : t('job.inbox.summary', { running: inbox.running.length, completed: inbox.completed })
  const count = t('job.inbox.count', { done: inbox.finished.length, total })
  return (
    <div ref={host} className="pointer-events-auto flex flex-col items-end">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
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
        <div className="mt-1.5 w-72 max-w-[80vw] rounded-xl border border-border bg-sidebar p-2 shadow-xl">
          <div className="flex items-center gap-2 px-1 pb-1.5">
            <InboxProgress
              completed={inbox.completed}
              failed={inbox.failed}
              running={inbox.running.length}
            />
            <span className={`shrink-0 text-[11px] tabular-nums ${INK_3}`}>{count}</span>
          </div>
          <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {rows.map((message) => (
              <InboxRow key={message.id} message={message} onLocate={() => setOpen(false)} />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
