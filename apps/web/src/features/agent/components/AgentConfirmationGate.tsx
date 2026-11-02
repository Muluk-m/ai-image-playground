import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { CARD_NOTE } from '../agentStyles'
import { startAgentNodeRun } from '../lib/nodeRuns'
import type { ConfirmationHint } from '../lib/pendingConfirmations'
import { agentToolFailureText } from '../lib/toolFailure'
import { useAgentStore } from '../store'

/**
 * 用户在输入栏打了短确认语、而面板上还有没点的卡时，把确认按钮送到输入栏上方。
 * 花钱的动作仍然是这一下点击，不把这句话交给模型去决定要不要再提交一次。
 */
export default function AgentConfirmationGate({
  pending,
  onJump,
  onSendAnyway,
}: {
  pending: readonly ConfirmationHint[]
  onJump: (messageId: string) => void
  onSendAnyway: () => void
}) {
  const { t } = useTranslation('agent')
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const drafts = pending.filter((one) => one.kind === 'draft')
  const nodeRuns = pending.filter((one) => one.kind === 'nodeRun')
  const first = pending[0]

  const confirmAll = () => {
    if (submitting || !drafts.length) return
    setSubmitting(true)
    setFailure(null)
    void useAgentStore
      .getState()
      .confirmAllPrompts()
      .then((result) => {
        if (result.failure && !result.failure.ok) {
          // 拟它的那一轮还在跑：说「还在拟」，不说成「已确认 0 张后停下、请逐张再试」——卡上此时也确认不了。
          setFailure(
            result.failure.reason === 'drafting'
              ? t('confirm.drafting')
              : ((result.failure.reason === 'refused'
                  ? agentToolFailureText(result.failure.code)
                  : null) ?? t('confirm.allFailed', { count: result.confirmed })),
          )
        }
        setSubmitting(false)
      })
  }

  const runNodes = () => {
    if (submitting || !nodeRuns.length) return
    setFailure(null)
    const messages = useAgentStore.getState().messages
    let missed = 0
    for (const hint of nodeRuns) {
      const message = messages.find((one) => one.id === hint.messageId)
      const proposal = message?.kind === 'tool' ? message.canvasRun : undefined
      if (!proposal || !startAgentNodeRun(hint.messageId, proposal)) missed += 1
    }
    if (missed > 0) setFailure(t('confirm.nodeRunMissed', { count: missed }))
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-2.5 py-2 text-xs"
    >
      <span className={`min-w-0 flex-1 ${CARD_NOTE}`}>
        {t('confirm.gate', { count: pending.length })}
      </span>
      {drafts.length > 0 && (
        <Button type="button" size="sm" disabled={submitting} onClick={confirmAll}>
          {submitting ? t('confirm.allSubmitting') : t('confirm.gateConfirm')}
        </Button>
      )}
      {nodeRuns.length > 0 && (
        <Button type="button" size="sm" disabled={submitting} onClick={runNodes}>
          {t('confirm.gateRunNodes', { count: nodeRuns.length })}
        </Button>
      )}
      {first && (
        <Button type="button" size="sm" variant="outline" onClick={() => onJump(first.messageId)}>
          {t('confirm.gateJump')}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onSendAnyway}>
        {t('confirm.gateSend')}
      </Button>
      {failure && (
        <p role="alert" className={`w-full ${CARD_NOTE}`}>
          {failure}
        </p>
      )}
    </div>
  )
}

export function scrollToAgentMessage(messageId: string): void {
  document
    .querySelector(`[data-agent-message-id="${CSS.escape(messageId)}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
