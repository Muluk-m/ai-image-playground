import { agentTurnCostTotal } from '@image-playground/shared'
import { Fragment, type ReactNode, useState } from 'react'
import { CARD_NOTE } from '../agentStyles'
import { formatCredits, formatTurnDuration } from '../lib/turnCost'
import type { AgentTurnFooter } from '../types'

const BREAKDOWN = [
  ['chat', '对话'],
  ['image', '生图'],
  ['video', '生视频'],
] as const

function BoltIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" aria-hidden="true">
      <path d="M7.1 1 2.5 7.1h2.4L4.5 11l4.6-6.1H6.7z" />
    </svg>
  )
}

export function Credits({ credits }: { credits: number }) {
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums">
      <BoltIcon />
      {formatCredits(credits)}
    </span>
  )
}

export default function AgentTurnCost({ footer }: { footer: AgentTurnFooter }) {
  const [open, setOpen] = useState(false)
  const cost = footer.cost
  const total = cost ? agentTurnCostTotal(cost) : null

  const parts: ReactNode[] = []
  if (footer.durationMs !== undefined) {
    parts.push(<span>本轮耗时 {formatTurnDuration(footer.durationMs)}</span>)
  } else if (footer.reservedCredits !== undefined) {
    parts.push(
      <span className="inline-flex items-center gap-1">
        预扣 <Credits credits={footer.reservedCredits} />
      </span>,
    )
  }
  if (total === 0) parts.push(<span>本轮免费，未扣积分</span>)
  if (total) {
    parts.push(
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex items-center gap-1 transition-colors hover:text-[#8b8b93]"
        onClick={() => setOpen(!open)}
      >
        消耗 <Credits credits={total} />
      </button>,
    )
  }

  return (
    <div className={`flex flex-wrap items-center gap-1 ${CARD_NOTE}`}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true">·</span>}
          {part}
        </Fragment>
      ))}
      {open && cost && (
        <span className="basis-full tabular-nums">
          {BREAKDOWN.filter(([key]) => cost[key] > 0)
            .map(([key, label]) => `${label} ${formatCredits(cost[key])}`)
            .join(' · ')}
        </span>
      )}
    </div>
  )
}
