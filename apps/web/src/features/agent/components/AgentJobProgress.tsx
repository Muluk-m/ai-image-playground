import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { JobProgress } from '../../../components/assistant-ui/elements/job-progress'
import { TooltipIconButton } from '../../../components/assistant-ui/elements/tooltip-icon-button'
import { Button } from '../../../components/ui/button'
import { Icon, type IconName } from '../../../components/ui/icon'
import { i18next, useTranslation } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { openPricingSheet } from '../../pricing/pricingSheetState'
import { CARD_NOTE } from '../agentStyles'
import { type AgentToolProgress, agentToolProgress, formatElapsed } from '../lib/jobProgress'
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

export function agentJobPhaseLabel(
  progress: Pick<AgentToolProgress, 'phase' | 'phaseSince' | 'queue'>,
  now = Date.now(),
): string {
  // 只说「排队中」用户不知道在等什么（BUG-17）：带上前面还有几张。
  if (progress.phase === 'queued' && progress.queue)
    return progress.queue.ahead > 0
      ? i18next.t('job.queue.ahead', { ns: 'agent', count: progress.queue.ahead })
      : i18next.t('job.queue.next', { ns: 'agent' })
  if (
    progress.phase === 'reconciling' &&
    progress.phaseSince !== undefined &&
    now - progress.phaseSince >= QUEUE_TIMEOUTS.RECONCILE_ALERT_AFTER_MS
  )
    return i18next.t('job.phase.reconcilingLate', { ns: 'agent' })
  return i18next.t(`job.phase.${progress.phase}`, { ns: 'agent' })
}

/** 「生成中 · 已用 0:42」这一句；卡片与画布占位说的是同一句。 */
export function useAgentJobProgressText(progress: AgentToolProgress | null): string | null {
  useTranslation('agent')
  const elapsed = useElapsed(progress?.since)
  if (!progress) return null
  const phase = agentJobPhaseLabel(progress)
  if (elapsed === null) return phase
  return i18next.t('job.progress', { ns: 'agent', phase, elapsed: formatElapsed(elapsed) })
}

/**
 * 排队的原因：账号同时生成的张数由套餐定，超出的按提交先后排队，多开对话也不会更快。
 * 有计费的部署顺带给升级入口。
 */
export function AgentJobQueueNote({ limit }: { limit: number }) {
  const { t } = useTranslation('agent')
  return (
    <p className={CARD_NOTE} data-agent-queue-note="">
      {t('job.queue.reason', { count: limit })}
      {isClientCapabilityEnabled('billing:credits') && (
        <>
          {' '}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 align-baseline"
            onClick={() => openPricingSheet()}
          >
            {t('job.queue.upgrade')}
          </Button>
        </>
      )}
    </p>
  )
}

/** 服务端只提供阶段，没有完成百分比；使用不定进度，避免把第三阶段画成 75%。 */
export default function AgentJobProgress({ progress }: { progress: AgentToolProgress }) {
  const { t } = useTranslation('agent')
  const text = useAgentJobProgressText(progress)
  return (
    <>
      <JobProgress
        aria-label={t('job.progressAria')}
        aria-valuetext={text ?? undefined}
        label={text ?? ''}
        className="text-xs"
      />
      {progress.phase === 'queued' && progress.queue && (
        <AgentJobQueueNote limit={progress.queue.limit} />
      )}
    </>
  )
}

// 同一任务可能同时有几个取消入口（每个占位图块、后台任务列表），取消中的状态按任务共享，只发一次请求。
const cancelling = new Map<string, Promise<void>>()
const cancelListeners = new Set<() => void>()
function subscribeCancelling(listener: () => void) {
  cancelListeners.add(listener)
  return () => cancelListeners.delete(listener)
}
function cancelJobOnce(messageId: string): Promise<void> {
  const running = cancelling.get(messageId)
  if (running) return running
  const request = useAgentStore
    .getState()
    .cancelJob(messageId)
    .finally(() => {
      cancelling.delete(messageId)
      for (const listener of cancelListeners) listener()
    })
  cancelling.set(messageId, request)
  for (const listener of cancelListeners) listener()
  return request
}

/** 后台任务还在跑时单独取消它；取消失败就在原处说一声，卡保持原样。 */
export function AgentJobCancel({
  message,
  className,
  icon = 'stop',
}: {
  message: AgentToolMessage
  className?: string
  icon?: IconName
}) {
  const { t } = useTranslation('agent')
  const pending = useSyncExternalStore(subscribeCancelling, () => cancelling.has(message.id))
  const [failed, setFailed] = useState(false)
  if (message.status !== 'submitted' || !message.job) return null
  return (
    <span className="inline-flex items-center gap-2 self-start">
      <TooltipIconButton
        tooltip={pending ? t('job.cancelling') : t('job.cancel')}
        disabled={pending}
        className={className}
        onClick={() => {
          setFailed(false)
          cancelJobOnce(message.id).catch(() => setFailed(true))
        }}
      >
        <Icon
          name={pending ? 'loading' : icon}
          className={pending ? 'animate-spin motion-reduce:animate-none' : undefined}
        />
      </TooltipIconButton>
      {failed && <span className={CARD_NOTE}>{t('job.cancelFailed')}</span>}
    </span>
  )
}
