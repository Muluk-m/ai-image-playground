import { LoaderCircle, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { JobProgress } from '../../../components/assistant-ui/elements/job-progress'
import { i18next, useTranslation } from '../../../i18n'
import { CARD_NOTE } from '../agentStyles'
import {
  type AgentJobPhase,
  type AgentToolProgress,
  agentToolProgress,
  formatElapsed,
} from '../lib/jobProgress'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'
import AgentIconButton from './AgentIconButton'

/** 这张卡此刻的进度，取自面板 store：结果卡与画布占位都走这一个入口。 */
export function useAgentToolProgress(message: AgentToolMessage | null): AgentToolProgress | null {
  const job = useAgentStore((state) => (message ? state.jobProgress[message.id] : undefined))
  const startedAt = useAgentStore((state) =>
    message ? state.toolStartedAt[message.id] : undefined,
  )
  return message ? agentToolProgress(message, job, startedAt) : null
}

/** 从 `since` 起已经过了多久，每秒走一次；没有起点就是 null。 */
export function useElapsed(since: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [since])
  return since === undefined ? null : Math.max(0, now - since)
}

export function agentJobPhaseLabel(phase: AgentJobPhase): string {
  return i18next.t(`job.phase.${phase}`, { ns: 'agent' })
}

/** 「生成中 · 已用 0:42」这一句；卡片与画布占位说的是同一句。 */
export function useAgentJobProgressText(progress: AgentToolProgress | null): string | null {
  useTranslation('agent')
  const elapsed = useElapsed(progress?.since)
  if (!progress) return null
  const phase = agentJobPhaseLabel(progress.phase)
  if (elapsed === null) return phase
  return i18next.t('job.progress', { ns: 'agent', phase, elapsed: formatElapsed(elapsed) })
}

/** 服务端只提供阶段，没有完成百分比；使用不定进度，避免把第三阶段画成 75%。 */
export default function AgentJobProgress({ progress }: { progress: AgentToolProgress }) {
  const { t } = useTranslation('agent')
  const text = useAgentJobProgressText(progress)
  return (
    <JobProgress
      aria-label={t('job.progressAria')}
      aria-valuetext={text ?? undefined}
      label={text ?? ''}
      className="text-xs"
    />
  )
}

/** 后台任务还在跑时单独取消它；取消失败就在原处说一声，卡保持原样。 */
export function AgentJobCancel({
  message,
  className,
}: {
  message: AgentToolMessage
  className?: string
}) {
  const { t } = useTranslation('agent')
  const [state, setState] = useState<'idle' | 'cancelling' | 'failed'>('idle')
  if (message.status !== 'submitted' || !message.job) return null
  return (
    <span className="inline-flex items-center gap-2 self-start">
      <AgentIconButton
        label={state === 'cancelling' ? t('job.cancelling') : t('job.cancel')}
        icon={state === 'cancelling' ? LoaderCircle : Square}
        busy={state === 'cancelling'}
        disabled={state === 'cancelling'}
        className={className}
        onClick={() => {
          setState('cancelling')
          useAgentStore
            .getState()
            .cancelJob(message.id)
            .then(
              () => setState('idle'),
              () => setState('failed'),
            )
        }}
      />
      {state === 'failed' && <span className={CARD_NOTE}>{t('job.cancelFailed')}</span>}
    </span>
  )
}
