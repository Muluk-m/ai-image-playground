import { ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
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
 * 收件箱顶上的整体进度：走满的一段是已完成，接着一段是没成的，余下留给还在跑的那几个，
 * 跑着就一直呼吸。一行字说不清「0 个进行中 · 19 个已完成」是多少活儿，一条条走满看得见。
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

function InboxRow({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const outcome = useOutcomeText(message)
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        title={t('job.inbox.locate')}
        className={`${LIST_ROW} min-w-0 flex-1 flex-col !items-start !gap-0.5`}
        onClick={() => locate(message)}
      >
        <span className={`w-full truncate ${INK}`}>{message.title}</span>
        <span className={`${CARD_NOTE} tabular-nums`}>{outcome}</span>
      </button>
      <AgentJobCancel message={message} />
    </li>
  )
}

/**
 * 面板顶部的后台任务收件箱：顶上一条进度说这批活儿走到哪儿了，展开是逐个任务，点一下定位到
 * 画布，在跑的能单独取消。数据全来自会话消息与服务端进度，刷新、换设备后是同一份。
 */
export default function AgentJobInbox() {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const inbox = useMemo(() => agentJobInbox(messages), [messages])
  const [open, setOpen] = useState(false)
  if (inbox.running.length === 0 && inbox.finished.length === 0) return null
  const rows = [...inbox.running, ...[...inbox.finished].reverse()]
  const total = inbox.running.length + inbox.finished.length
  const label =
    inbox.failed > 0
      ? t('job.inbox.summaryFailed', {
          running: inbox.running.length,
          completed: inbox.completed,
          failed: inbox.failed,
        })
      : t('job.inbox.summary', { running: inbox.running.length, completed: inbox.completed })
  return (
    <section aria-label={t('job.inbox.aria')} className="mx-3 mb-1 shrink-0 rounded-lg bg-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-[11px] ${INK_3}`}
      >
        <InboxProgress
          completed={inbox.completed}
          failed={inbox.failed}
          running={inbox.running.length}
        />
        <span className="shrink-0 tabular-nums">
          {t('job.inbox.count', { done: inbox.finished.length, total })}
        </span>
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto px-1 pb-1">
          {rows.map((message) => (
            <InboxRow key={message.id} message={message} />
          ))}
        </ul>
      )}
    </section>
  )
}
