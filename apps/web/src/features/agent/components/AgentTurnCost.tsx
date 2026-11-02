import { agentTurnCostTotal, type AgentTurnCost as TurnCost } from '@image-playground/shared'
import { Fragment, type ReactNode, useState } from 'react'
import { StoppedRun } from '../../../components/assistant-ui/elements/stopped-run'
import Credits from '../../../components/Credits'
import { Button } from '../../../components/ui/button'
import { Icon } from '../../../components/ui/icon'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useTranslation } from '../../../i18n'
import { formatCount } from '../../../i18n/format'
import { turnCostWithJobs } from '../lib/turnCost'
import { useAgentStore } from '../store'
import type { AgentToolMessage, AgentTurnFooter } from '../types'
import AgentCopyDiagnostic from './AgentCopyDiagnostic'

const BREAKDOWN = [
  ['chat', 'label.chat'],
  ['image', 'cost.image'],
  ['video', 'cost.video'],
] as const

export default function AgentTurnCost({
  footer,
  jobs = [],
  outputCount,
}: {
  footer: AgentTurnFooter
  jobs?: readonly AgentToolMessage[]
  outputCount?: number
}) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const resumeBlocked = useAgentStore(
    (state) => state.turn === 'running' || state.historyLoading || state.historyFailed,
  )

  const cost = footer.cost ? turnCostWithJobs(footer.cost, jobs) : undefined
  const total = cost ? agentTurnCostTotal(cost) : null
  const failed = footer.stopReason === 'failed'
  const waivedChat =
    footer.stopReason === 'completed' && cost?.chat === 0 && cost.chatWaived !== undefined

  if (waivedChat && cost && total)
    return <ChatFreeReceipt cost={cost} durationMs={footer.durationMs} outputCount={outputCount} />

  // 进行中不写预扣：那是内部记账，用户只关心结算后的实际消耗；进行中由状态行表达。
  const extra: ReactNode[] = []
  if (failed)
    extra.push(
      <span key="failed">
        {t(
          footer.error === 'agent_turn_interrupted'
            ? 'cost.interrupted'
            : footer.error === 'agent_request_budget_exceeded'
              ? 'cost.requestBudgetExceeded'
              : footer.error === 'agent_context_overflow'
                ? 'cost.contextOverflow'
                : 'cost.failed',
        )}
      </span>,
    )

  const breakdown =
    open && cost ? (
      <span className="basis-full tabular-nums">
        {BREAKDOWN.filter(([key]) => cost[key] > 0).map(([key, labelKey], index) => {
          const amount = formatCount(cost[key])
          return (
            <Fragment key={key}>
              {index > 0 && <span aria-hidden="true"> · </span>}
              {t(labelKey)} {amount}
            </Fragment>
          )
        })}
      </span>
    ) : null

  const receipt = (
    <CostLine
      durationMs={footer.durationMs}
      outputCount={outputCount}
      amount={total && total > 0 ? total : null}
      open={open}
      onToggle={() => setOpen(!open)}
      extra={
        <>
          {extra}
          {failed && footer.error !== 'agent_turn_interrupted' && (
            <AgentCopyDiagnostic
              diagnostic={{
                ...footer.failure,
                code: footer.error,
                turnId: footer.turnId,
                durationMs: footer.durationMs,
              }}
            />
          )}
        </>
      }
      breakdown={breakdown}
    />
  )
  const visible = extra.length > 0 || footer.durationMs !== undefined || (total ?? 0) > 0
  return footer.stopReason === 'aborted' ? (
    <StoppedRun
      reason={t('cost.stopped')}
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={resumeBlocked}
          onClick={() => void useAgentStore.getState().send(t('cost.continuePrompt'))}
        >
          {t('cost.continue')}
          <Icon name="arrowRight" />
        </Button>
      }
    >
      {visible ? receipt : null}
    </StoppedRun>
  ) : visible ? (
    receipt
  ) : null
}

/** `28s · 100 积分 · 明细`。明细展开分类或减免，不再用悬浮的箭头。 */
function CostLine({
  durationMs,
  outputCount,
  amount,
  open,
  onToggle,
  extra,
  breakdown,
}: {
  durationMs?: number
  outputCount?: number
  amount: number | null
  open: boolean
  onToggle: () => void
  extra?: ReactNode
  breakdown?: ReactNode
}) {
  const { t } = useTranslation('agent')
  const duration = durationMs !== undefined ? formatElapsed(durationMs) : null
  return (
    <div
      className={
        outputCount === undefined
          ? 'studio-agent-turn-cost flex flex-wrap items-center gap-x-1.5 gap-y-1 text-label-sm text-muted-foreground'
          : 'studio-agent-batch-cost'
      }
    >
      {extra}
      {duration && (
        <span className="tabular-nums" aria-label={t('cost.duration', { duration })}>
          {duration}
        </span>
      )}
      {outputCount !== undefined && <span>{t('tool.batchCount', { count: outputCount })}</span>}
      {amount !== null && (
        <>
          {duration && outputCount === undefined && <span aria-hidden="true">·</span>}
          {outputCount === undefined ? (
            <span className="tabular-nums">
              {t('cost.credits', { amount: formatCount(amount) })}
            </span>
          ) : (
            <Credits credits={amount} />
          )}
          {outputCount === undefined && <span aria-hidden="true">·</span>}
          <Button
            type="button"
            variant="ghost"
            aria-expanded={open}
            aria-label={t('cost.receiptToggle')}
            className="h-auto gap-0 px-0 py-0 text-label-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={onToggle}
          >
            {t('cost.details')}
          </Button>
        </>
      )}
      {breakdown}
    </div>
  )
}

function ChatFreeReceipt({
  cost,
  durationMs,
  outputCount,
}: {
  cost: TurnCost
  durationMs?: number
  outputCount?: number
}) {
  const [open, setOpen] = useState(false)
  const spent = agentTurnCostTotal(cost)
  return (
    <CostLine
      durationMs={durationMs}
      outputCount={outputCount}
      amount={spent > 0 ? spent : null}
      open={open}
      onToggle={() => setOpen(!open)}
      breakdown={open ? <ReceiptBreakdown cost={cost} spent={spent} /> : null}
    />
  )
}

function ReceiptBreakdown({ cost, spent }: { cost: TurnCost; spent: number }) {
  const { t } = useTranslation('agent')
  const waived = cost.chatWaived
  const knownWaiver = typeof waived === 'number' && waived > 0
  return (
    <div className="basis-full rounded-lg px-0 py-1 text-label-sm tabular-nums text-muted-foreground">
      {knownWaiver && <ReceiptRow label={t('cost.original')} amount={spent + waived} />}
      <ReceiptRow label={t('cost.chatWaiver')} amount={knownWaiver ? waived : null} negative />
      <div className="my-1 border-t border-border" />
      <ReceiptRow label={t('cost.paid')} amount={spent} strong />
    </div>
  )
}

function ReceiptRow({
  label,
  amount,
  negative = false,
  strong = false,
}: {
  label: string
  amount: number | null
  negative?: boolean
  strong?: boolean
}) {
  const { t } = useTranslation('agent')
  return (
    <div
      className={`flex items-center justify-between gap-4 py-0.5 ${strong ? 'font-medium text-foreground' : ''}`}
    >
      <span>{label}</span>
      <span className={`inline-flex items-center gap-0.5 ${negative ? 'text-primary' : ''}`}>
        {amount === null ? (
          t('cost.waivedShort')
        ) : (
          <>
            {negative && '−'}
            <Credits credits={amount} />
          </>
        )}
      </span>
    </div>
  )
}
