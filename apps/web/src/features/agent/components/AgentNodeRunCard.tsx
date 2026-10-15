import type { AgentCanvasRunProposal } from '@image-playground/shared'
import { useState, useSyncExternalStore } from 'react'
import { ApprovalCard } from '../../../components/assistant-ui/elements/approval-card'
import Credits from '../../../components/Credits'
import { Icon } from '../../../components/ui/icon'
import { useTranslation } from '../../../i18n'
import { usePrivateSubmissionGuard } from '../../../lib/privateOverlay'
import NodeBatchJobs from '../../canvas/components/NodeBatchJobs'
import { CARD_NOTE } from '../agentStyles'
import { agentNodeRunBridge, subscribeAgentNodeRun } from '../lib/nodeRunBridge'

export default function AgentNodeRunCard({ proposal }: { proposal: AgentCanvasRunProposal }) {
  const { t } = useTranslation(['agent', 'canvas'])
  const bridge = useSyncExternalStore(subscribeAgentNodeRun, agentNodeRunBridge)
  const [changed, setChanged] = useState(false)
  const plan = bridge?.quote(proposal)
  usePrivateSubmissionGuard({ model: plan?.jobs[0]?.model ?? '', quantity: 1 })
  const error = plan?.error
  return (
    <ApprovalCard
      state="request"
      title={t('nodeRun.title')}
      subtitle={
        plan ? t('canvas:nodeBatch.summary', { count: plan.jobs.length }) : t('nodeRun.unavailable')
      }
      icon={<Icon name="play" size="sm" />}
      disabled={!plan || Boolean(error) || plan.blocked}
      allowOnceLabel={t('nodeRun.review')}
      onAllowOnce={() => {
        if (!bridge || !plan) return
        setChanged(!bridge.review(proposal, plan.signature))
      }}
    >
      {plan && (
        <>
          <NodeBatchJobs jobs={plan.jobs} />
          <p className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>{t('canvas:nodes.estimatedCost')}</span>
            {plan.credits === undefined ? (
              <span>{t('nodeRun.unpriced')}</span>
            ) : (
              <Credits credits={plan.credits} />
            )}
          </p>
        </>
      )}
      {(!plan || error || plan.blockedReason || changed) && (
        <p role="status" className={CARD_NOTE}>
          {!plan
            ? t('nodeRun.unavailable')
            : error
              ? t(`canvas:nodeBatch.${error}`)
              : plan.blockedReason || t('nodeRun.changed')}
        </p>
      )}
    </ApprovalCard>
  )
}
