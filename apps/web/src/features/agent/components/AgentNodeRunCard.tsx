import type { AgentCanvasRunProposal } from '@image-playground/shared'
import { useSyncExternalStore } from 'react'
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
  startAgentNodeRun,
  stopAgentNodeRun,
  subscribeAgentNodeRuns,
} from '../lib/nodeRuns'

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
  // 运行开始后节点正在生成，现报价会是 busy；卡上始终展示开跑那一刻的批次。
  const plan = run ? undefined : bridge?.quote(proposal)
  const jobs = run?.jobs ?? plan?.jobs
  const credits = run ? run.credits : plan?.credits
  usePrivateSubmissionGuard({ model: jobs?.[0]?.model ?? '', quantity: 1 })
  const subtitle = jobs
    ? t('canvas:nodeBatch.summary', { count: jobs.length })
    : t('nodeRun.unavailable')
  const list = jobs && (
    <>
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
      <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span>{t('canvas:nodes.estimatedCost')}</span>
        {credits === undefined ? (
          <span>{t('nodeRun.unpriced')}</span>
        ) : (
          <Credits credits={credits} />
        )}
      </p>
    </>
  )
  const icon = <Icon name="play" size="sm" />
  if (run?.status === 'countdown')
    return (
      <ApprovalCard
        state="request"
        title={t('nodeRun.title')}
        subtitle={t('nodeRun.startingIn', { seconds: run.remaining })}
        icon={icon}
        allowOnceLabel={t('nodeRun.undo', { seconds: run.remaining })}
        onAllowOnce={() => stopAgentNodeRun(runKey)}
      >
        {list}
      </ApprovalCard>
    )
  if (run?.status === 'running')
    return (
      <ApprovalCard
        state="request"
        title={t('nodeRun.title')}
        subtitle={t('nodeRun.running')}
        icon={icon}
        denyLabel={t('canvas:nodeBatch.stop')}
        onDeny={() => stopAgentNodeRun(runKey)}
      >
        {list}
      </ApprovalCard>
    )
  if (run)
    return (
      <ApprovalCard
        state={run.status === 'done' ? 'done' : 'denied'}
        title={t('nodeRun.title')}
        subtitle={subtitle}
        icon={icon}
        statusLabel={
          run.status === 'done'
            ? t('canvas:nodeBatch.done')
            : run.status === 'undone'
              ? t('nodeRun.undone')
              : t(`canvas:nodeBatch.${run.error}`)
        }
      >
        {list}
      </ApprovalCard>
    )
  const error = plan?.error
  return (
    <ApprovalCard
      state="request"
      title={t('nodeRun.title')}
      subtitle={subtitle}
      icon={icon}
      disabled={!plan || Boolean(error) || plan.blocked}
      allowOnceLabel={t('nodeRun.run')}
      onAllowOnce={() => startAgentNodeRun(runKey, proposal)}
    >
      {list}
      {(!plan || error || plan.blockedReason) && (
        <p role="status" className={CARD_NOTE}>
          {!plan
            ? t('nodeRun.unavailable')
            : error
              ? t(`canvas:nodeBatch.${error}`)
              : plan.blockedReason}
        </p>
      )}
    </ApprovalCard>
  )
}
