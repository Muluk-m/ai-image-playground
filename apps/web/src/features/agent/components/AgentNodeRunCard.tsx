import type { AgentCanvasRunProposal, StageAuthorization } from '@image-playground/shared'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApprovalCard } from '../../../components/assistant-ui/elements/approval-card'
import Credits from '../../../components/Credits'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import NodeBatchJobs from '../../canvas/components/NodeBatchJobs'
import { CARD_NOTE } from '../agentStyles'
import { agentNodeRunBridge, subscribeAgentNodeRun } from '../lib/nodeRunBridge'
import {
  agentNodeRun,
  isAgentNodeRunOrigin,
  startAgentNodeRun,
  stopAgentNodeRun,
  subscribeAgentNodeRuns,
} from '../lib/nodeRuns'
import { stageAuthorizationClient } from '../lib/stageAuthorizationClient'

export default function AgentNodeRunCard({
  runKey,
  proposal,
}: {
  runKey: string
  proposal: AgentCanvasRunProposal
}) {
  const { t } = useTranslation(['agent', 'canvas'])
  const bridge = useSyncExternalStore(subscribeAgentNodeRun, agentNodeRunBridge)
  const run = useSyncExternalStore(subscribeAgentNodeRuns, () => agentNodeRun(runKey))
  const origin = useSyncExternalStore(subscribeAgentNodeRuns, () => isAgentNodeRunOrigin(runKey))
  const [stored, setStored] = useState<StageAuthorization>()
  useEffect(() => {
    if (!proposal.authorizationId) return
    let active = true
    let timer: number | undefined
    const refresh = async () => {
      try {
        const state = await stageAuthorizationClient.read(proposal.authorizationId)
        if (!active) return
        setStored(state)
        if (state.status === 'pending' || state.status === 'active')
          timer = window.setTimeout(() => {
            void refresh()
          }, 3000)
      } catch {
        if (active)
          timer = window.setTimeout(() => {
            void refresh()
          }, 3000)
      }
    }
    void refresh()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [proposal.authorizationId])
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
  }
  const subtitle =
    run?.status === 'countdown'
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
  const statusLabel =
    run?.status === 'done'
      ? t('canvas:nodeBatch.done')
      : run?.status === 'undone'
        ? t('nodeRun.undone')
        : run?.status === 'failed'
          ? t(`canvas:nodeBatch.${run.error}`)
          : subtitle
  const canConfirm = !run && pending && origin
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
      disabled={canConfirm && (!stored || !plan || Boolean(plan.error) || plan.blocked)}
      {...(canConfirm
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
        />
      )}
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>{t('canvas:nodes.estimatedCost')}</span>
        {credits === undefined ? (
          <span>{t('nodeRun.unpriced')}</span>
        ) : (
          <Credits credits={credits} />
        )}
      </p>
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
