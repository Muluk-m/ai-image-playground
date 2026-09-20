import { useEffect, useState } from 'react'
import { i18next, useTranslation } from '../../../i18n'
import { CARD_NOTE, GHOST_LINK, INK_3 } from '../agentStyles'
import {
  AGENT_JOB_STEPS,
  type AgentJobPhase,
  type AgentToolProgress,
  agentJobStep,
  agentToolProgress,
  formatElapsed,
} from '../lib/jobProgress'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

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

/** 分阶段进度：四格刻度标出走到哪一步，下面一句说阶段与已用时间。 */
export default function AgentJobProgress({ progress }: { progress: AgentToolProgress }) {
  const { t } = useTranslation('agent')
  const text = useAgentJobProgressText(progress)
  const reached = AGENT_JOB_STEPS.indexOf(agentJobStep(progress.phase))
  return (
    <div
      role="progressbar"
      aria-label={t('job.progressAria')}
      aria-valuemin={1}
      aria-valuemax={AGENT_JOB_STEPS.length}
      aria-valuenow={reached + 1}
      aria-valuetext={text ?? undefined}
      className="flex flex-col gap-1"
    >
      <div className="flex gap-1" aria-hidden="true">
        {AGENT_JOB_STEPS.map((step, index) => (
          <span
            key={step}
            className={`h-1 flex-1 rounded-full ${
              index < reached
                ? 'bg-primary'
                : index === reached
                  ? 'animate-pulse bg-primary'
                  : 'bg-border'
            }`}
          />
        ))}
      </div>
      <p className={`text-[11px] tabular-nums ${INK_3}`}>{text}</p>
    </div>
  )
}

/** 后台任务还在跑时单独取消它；取消失败就在原处说一声，卡保持原样。 */
export function AgentJobCancel({ message }: { message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const [state, setState] = useState<'idle' | 'cancelling' | 'failed'>('idle')
  if (message.status !== 'submitted' || !message.job) return null
  return (
    <span className="inline-flex items-center gap-2 self-start">
      <button
        type="button"
        disabled={state === 'cancelling'}
        className={`${GHOST_LINK} disabled:opacity-50`}
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
      >
        {state === 'cancelling' ? t('job.cancelling') : t('job.cancel')}
      </button>
      {state === 'failed' && <span className={CARD_NOTE}>{t('job.cancelFailed')}</span>}
    </span>
  )
}
