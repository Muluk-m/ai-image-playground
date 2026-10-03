import { agentTurnCostTotal, type AgentTurnCost as TurnCost } from '@image-playground/shared'
import { ChevronDown, ImageIcon, MessageCircle, VideoIcon } from 'lucide-react'
import { Fragment, type ReactNode, useState } from 'react'
import Credits from '../../../components/Credits'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useTranslation } from '../../../i18n'
import { formatCount } from '../../../i18n/format'
import { CARD_NOTE } from '../agentStyles'
import { turnCostWithJobs } from '../lib/turnCost'
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
}: {
  footer: AgentTurnFooter
  jobs?: readonly AgentToolMessage[]
}) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const cost = footer.cost ? turnCostWithJobs(footer.cost, jobs) : undefined
  const total = cost ? agentTurnCostTotal(cost) : null
  const failed = footer.stopReason === 'failed'
  const waivedChat =
    footer.stopReason === 'completed' && cost?.chat === 0 && cost.chatWaived !== undefined

  if (waivedChat && cost && total)
    return <ChatFreeReceipt cost={cost} durationMs={footer.durationMs} />

  // 进行中不写预扣：那是内部记账，用户只关心结算后的实际消耗；进行中由状态行表达。
  const parts: ReactNode[] = []
  if (failed)
    parts.push(
      <span>
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
  if (footer.stopReason === 'aborted') parts.push(<span>{t('cost.stopped')}</span>)
  if (footer.durationMs !== undefined) {
    parts.push(<span>{t('cost.duration', { duration: formatElapsed(footer.durationMs) })}</span>)
  }
  if (total) {
    parts.push(
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        {t('cost.spent')} <Credits credits={total} />
      </button>,
    )
  }

  return (
    <div className={`studio-agent-turn-cost flex flex-wrap items-center gap-1 ${CARD_NOTE}`}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true">·</span>}
          {part}
        </Fragment>
      ))}
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
      {open && cost && (
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
      )}
    </div>
  )
}

function ChatFreeReceipt({ cost, durationMs }: { cost: TurnCost; durationMs?: number }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const spent = agentTurnCostTotal(cost)
  const waived = cost.chatWaived
  const knownWaiver = typeof waived === 'number' && waived > 0

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${CARD_NOTE}`}>
      {durationMs !== undefined && (
        <span className="mr-0.5 tabular-nums">{formatElapsed(durationMs)}</span>
      )}
      {cost.image > 0 && (
        <span
          role="group"
          aria-label={t('cost.imageSpentAria', { amount: formatCount(cost.image) })}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-1 text-foreground"
        >
          <ImageIcon className="h-3 w-3" aria-hidden="true" />
          <Credits credits={cost.image} />
        </span>
      )}
      {cost.video > 0 && (
        <span
          role="group"
          aria-label={t('cost.videoSpentAria', { amount: formatCount(cost.video) })}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-1 text-foreground"
        >
          <VideoIcon className="h-3 w-3" aria-hidden="true" />
          <Credits credits={cost.video} />
        </span>
      )}
      <span
        role="group"
        aria-label={
          knownWaiver
            ? t('cost.waivedAria', { amount: formatCount(waived) })
            : t('cost.waivedUnknownAria')
        }
        className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-1 text-primary"
      >
        <MessageCircle className="h-3 w-3" aria-hidden="true" />
        {knownWaiver && <Credits credits={waived} struck />}
        <span className="font-semibold">{t('cost.waivedShort')}</span>
      </span>
      <button
        type="button"
        aria-label={t('cost.receiptToggle')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="ml-auto rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="basis-full rounded-lg border border-border bg-muted/60 px-2.5 py-2 tabular-nums">
          {knownWaiver && <ReceiptRow label={t('cost.original')} amount={spent + waived} />}
          <ReceiptRow label={t('cost.chatWaiver')} amount={knownWaiver ? waived : null} negative />
          <div className="my-1 border-t border-border" />
          <ReceiptRow label={t('cost.paid')} amount={spent} strong />
        </div>
      )}
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
      className={`flex items-center justify-between py-0.5 ${strong ? 'font-semibold text-foreground' : ''}`}
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
