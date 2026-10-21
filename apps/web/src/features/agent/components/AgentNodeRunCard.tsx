import type {
  AgentCanvasRunProposal,
  AgentWakeSkipReason,
  StageAuthorization,
} from '@image-playground/shared'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApprovalCard } from '../../../components/assistant-ui/elements/approval-card'
import Credits from '../../../components/Credits'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import NodeBatchJobs from '../../canvas/components/NodeBatchJobs'
import { CARD_NOTE } from '../agentStyles'
import { agentNodeRunBridge, subscribeAgentNodeRun } from '../lib/nodeRunBridge'
import {
  type AgentNodeRun,
  agentNodeRun,
  agentNodeRunControl,
  agentNodeRunWakeSkipped,
  forgetAgentNodeRun,
  isAgentNodeRunOrigin,
  startAgentNodeRun,
  stopAgentNodeRun,
  subscribeAgentNodeRuns,
} from '../lib/nodeRuns'
import { stageAuthorizationClient } from '../lib/stageAuthorizationClient'

export default function AgentNodeRunCard({
  runKey,
  proposal,
  wakeSkipped,
}: {
  runKey: string
  proposal: AgentCanvasRunProposal
  /** 服务端记在运行卡上的「唤醒没有起轮」原因；刷新之后也在。 */
  wakeSkipped?: AgentWakeSkipReason
}) {
  const { t } = useTranslation(['agent', 'canvas'])
  const bridge = useSyncExternalStore(subscribeAgentNodeRun, agentNodeRunBridge)
  const live = useSyncExternalStore(subscribeAgentNodeRuns, () => agentNodeRun(runKey))
  const settled = useRef<AgentNodeRun>(undefined)
  const run = live ?? settled.current
  const origin = useSyncExternalStore(subscribeAgentNodeRuns, () => isAgentNodeRunOrigin(runKey))
  const skippedLive = useSyncExternalStore(subscribeAgentNodeRuns, () =>
    agentNodeRunWakeSkipped(proposal.authorizationId),
  )
  const [stored, setStored] = useState<StageAuthorization>()
  const [readFailed, setReadFailed] = useState(false)
  const [readAttempt, setReadAttempt] = useState(0)
  useEffect(() => {
    if (live && (live.status === 'done' || live.status === 'undone' || live.status === 'failed'))
      settled.current = live
  }, [live])
  useEffect(() => {
    if (!proposal.direct || !origin || !bridge) return
    startAgentNodeRun(runKey, proposal, 0)
  }, [bridge, origin, proposal, runKey])
  useEffect(() => {
    if (!live || (live.status !== 'done' && live.status !== 'undone' && live.status !== 'failed'))
      return
    // 结局还在交给智能体：交完再收走，卡上才看得到交没交上。
    if (live.report?.wake === 'reporting') return
    forgetAgentNodeRun(runKey, agentNodeRunControl(runKey))
  }, [live, runKey])
  useEffect(() => {
    const authorizationId = proposal.authorizationId
    if (!authorizationId || proposal.direct) return
    let active = true
    let timer: number | undefined
    let failures = 0
    const refresh = async () => {
      try {
        const state = await stageAuthorizationClient.read(authorizationId)
        if (!active) return
        failures = 0
        setReadFailed(false)
        setStored(state)
        if (state.status === 'pending' || state.status === 'active')
          timer = window.setTimeout(() => {
            void refresh()
          }, 3000)
      } catch {
        if (!active) return
        failures += 1
        if (failures >= 5) {
          setReadFailed(true)
          return
        }
        const delay = Math.min(30_000, 3000 * 2 ** (failures - 1))
        timer = window.setTimeout(() => {
          void refresh()
        }, delay)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [proposal.authorizationId, proposal.direct, readAttempt])
  const authorization =
    run?.authorization &&
    (run.status !== 'running' || run.authorization.audit.length > (stored?.audit.length ?? 0))
      ? run.authorization
      : stored
  const plan = run ? undefined : bridge?.quote(proposal)
  const jobs = run?.jobs ?? plan?.jobs
  const credits = run?.credits ?? plan?.credits ?? proposal.estimatedCredits
  usePrivateSubmissionGuard({ model: jobs?.[0]?.model ?? '', quantity: 1 })
  const pending = (authorization?.status ?? proposal.status) === 'pending'
  const submitted = authorization?.attempts.some((attempt) => attempt.taskIds.length > 0)
  const status = authorization?.status ?? proposal.status
  const statusLabels: Record<StageAuthorization['status'], string> = {
    pending: t('nodeRun.status.pending'),
    active: t('nodeRun.status.active'),
    exhausted: t('nodeRun.status.exhausted'),
    ended: t('nodeRun.status.ended'),
    expired: t('nodeRun.status.expired'),
  }
  const subtitle = readFailed
    ? t('nodeRun.readFailed')
    : run?.status === 'countdown'
      ? t('nodeRun.startingIn', { seconds: run.remaining })
      : run?.status === 'confirming'
        ? t('nodeRun.confirming')
        : run?.status === 'running'
          ? t('nodeRun.running')
          : submitted && status === 'active'
            ? t('nodeRun.submitted')
            : status
              ? statusLabels[status]
              : t('nodeRun.unavailable')
  const terminal = run?.status === 'done' || run?.status === 'undone' || run?.status === 'failed'
  const report = run?.report
  const outcomes = report
    ? Object.fromEntries(report.nodes.map((node) => [node.nodeId, node.outcome]))
    : undefined
  const unfinished = report?.nodes.filter((node) => node.outcome !== 'completed').length ?? 0
  const skippedReason = wakeSkipped ?? skippedLive
  const statusLabel =
    run?.status === 'done' && unfinished > 0
      ? t('nodeRun.partial', { count: unfinished })
      : run?.status === 'done'
        ? t('canvas:nodeBatch.done')
        : run?.status === 'undone'
          ? t('nodeRun.undone')
          : run?.status === 'failed'
            ? t(`canvas:nodeBatch.${run.error}`)
            : subtitle
  const canConfirm = !proposal.direct && !run && pending && origin
  if (proposal.direct && !run && !plan?.error && !plan?.blocked && !skippedReason) return null
  const canUndo = run?.status === 'countdown'
  return (
    <ApprovalCard
      state={
        terminal
          ? run.status === 'done'
            ? 'done'
            : 'denied'
          : run || canConfirm
            ? 'request'
            : 'done'
      }
      title={`${t('nodeRun.title')} · ${proposal.stage ?? ''}`}
      subtitle={subtitle}
      statusLabel={statusLabel}
      icon={<Icon name="play" size="sm" />}
      disabled={
        canConfirm && !readFailed && (!stored || !plan || Boolean(plan.error) || plan.blocked)
      }
      {...(canConfirm && !readFailed
        ? {
            allowOnceLabel: t('nodeRun.run'),
            onAllowOnce: () => startAgentNodeRun(runKey, proposal),
          }
        : {})}
      {...(canUndo
        ? {
            allowOnceLabel: t('nodeRun.undo', { seconds: run.remaining }),
            onAllowOnce: () => stopAgentNodeRun(runKey),
          }
        : {})}
      {...(run?.status === 'running' || run?.status === 'confirming'
        ? { denyLabel: t('canvas:nodeBatch.stop'), onDeny: () => stopAgentNodeRun(runKey) }
        : {})}
      details={[
        {
          label: t('nodeRun.scope'),
          value: (authorization?.nodeNames ?? proposal.nodeNames ?? []).join('、'),
        },
        {
          label: t('nodeRun.budget'),
          value: String(authorization?.budgetCap ?? proposal.budgetCap ?? 0),
        },
        { label: t('nodeRun.spent'), value: String(authorization?.spentCredits ?? 0) },
      ]}
    >
      {proposal.storyboard && <StoryboardSummary summary={proposal.storyboard} />}
      {jobs && (
        <NodeBatchJobs
          jobs={jobs}
          completed={
            run?.status === 'done'
              ? jobs.length
              : run?.status === 'running' || run?.status === 'failed'
                ? run.completed
                : 0
          }
          {...(run?.status === 'running' ? { active: run.active } : {})}
          {...(outcomes ? { outcomes } : {})}
        />
      )}
      {(skippedReason === 'insufficient_credits' || skippedReason === 'wake_limit') && (
        <p role="status" className={CARD_NOTE}>
          {t(`job.wakeSkipped.${skippedReason}`)}
        </p>
      )}
      {!skippedReason && (report?.wake === 'queued' || report?.wake === 'duplicate') && (
        <p role="status" className={CARD_NOTE}>
          {t('nodeRun.reported')}
        </p>
      )}
      {report?.wake === 'failed' && (
        <p role="status" className={CARD_NOTE}>
          {t('nodeRun.reportFailed')}
        </p>
      )}
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>{t('canvas:nodes.estimatedCost')}</span>
        {credits === undefined ? (
          <span>{t('nodeRun.unpriced')}</span>
        ) : (
          <Credits credits={credits} />
        )}
      </p>
      {readFailed && (
        <p role="status" className={CARD_NOTE}>
          {t('nodeRun.readFailed')}{' '}
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto px-0 text-label-sm"
            onClick={() => setReadAttempt((attempt) => attempt + 1)}
          >
            {t('nodeRun.retryRead')}
          </Button>
        </p>
      )}
      {!run && (!origin || !plan || plan.error || plan.blockedReason) && (
        <p role="status" className={CARD_NOTE}>
          {!origin
            ? t('nodeRun.originOnly')
            : !plan
              ? t('nodeRun.unavailable')
              : plan.error
                ? t(`canvas:nodeBatch.${plan.error}`)
                : plan.blockedReason}
        </p>
      )}
    </ApprovalCard>
  )
}

const SUMMARY_SHOTS_SHOWN = 12

/** 首帧阶段的镜头表摘要：用户确认的就是「按这张表开拍」，确认即定稿。 */
function StoryboardSummary({
  summary,
}: {
  summary: NonNullable<AgentCanvasRunProposal['storyboard']>
}) {
  const { t } = useTranslation('agent')
  const shown = summary.shots.slice(0, SUMMARY_SHOTS_SHOWN)
  return (
    <div className="grid gap-1 text-xs">
      <p className="font-medium">
        {t('nodeRun.storyboard.summary', {
          count: summary.shotCount,
          seconds: summary.totalSeconds,
        })}
      </p>
      <ol className="grid gap-0.5 text-muted-foreground">
        {shown.map((shot, index) => (
          <li key={shot.id}>
            {t('nodeRun.storyboard.shot', {
              index: index + 1,
              seconds: shot.durationSeconds,
              line: shot.line,
            })}
          </li>
        ))}
      </ol>
      {summary.shots.length > shown.length && (
        <p className="text-muted-foreground">
          {t('nodeRun.storyboard.more', { count: summary.shots.length - shown.length })}
        </p>
      )}
      <p className={CARD_NOTE}>{t('nodeRun.storyboard.finalizes')}</p>
    </div>
  )
}
