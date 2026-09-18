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

/** 点一行就把镜头带到它在画布上的那一处：结束了的是产物，还在跑的是它占的位。 */
function locate(message: AgentToolMessage): void {
  const sink = agentCanvasSink()
  if (!sink) return
  if (message.status === 'submitted') {
    sink.focusPending?.({
      messageId: message.id,
      ...(message.job ? { taskId: message.job.taskId } : {}),
    })
    return
  }
  sink.focus((message.artifacts ?? []).map((artifact) => artifact.artifactId))
}

function useOutcomeText(message: AgentToolMessage): string {
  const { t } = useTranslation('agent')
  const progress = useAgentToolProgress(message)
  const running = useAgentJobProgressText(progress)
  if (running) return running
  if (message.status === 'succeeded') return t('job.inbox.succeeded')
  if (message.errorCode === 'cancelled') return t('job.cancelled')
  return agentToolFailureText(message.errorCode) ?? t('job.inbox.failed')
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
 * 面板顶部的后台任务收件箱：一行说几个在跑、几个已完成，展开是逐个任务，点一下定位到画布，
 * 在跑的能单独取消。数据全来自会话消息与服务端进度，刷新、换设备后是同一份。
 */
export default function AgentJobInbox() {
  const { t } = useTranslation('agent')
  const messages = useAgentStore((state) => state.messages)
  const inbox = useMemo(() => agentJobInbox(messages), [messages])
  const [open, setOpen] = useState(false)
  if (inbox.running.length === 0 && inbox.finished.length === 0) return null
  const rows = [...inbox.running, ...[...inbox.finished].reverse()]
  return (
    <section aria-label={t('job.inbox.aria')} className="mx-3 mb-1 shrink-0 rounded-lg bg-muted">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-[11px] ${INK_3}`}
      >
        {inbox.running.length > 0 && (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary"
            aria-hidden="true"
          />
        )}
        <span className="flex-1 text-left">
          {t('job.inbox.summary', {
            running: inbox.running.length,
            completed: inbox.completed,
          })}
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
