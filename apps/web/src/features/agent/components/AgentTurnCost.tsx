import { agentTurnCostTotal } from '@image-playground/shared'
import { Fragment, type ReactNode, useState } from 'react'
import Credits, { formatCredits } from '../../../components/Credits'
import { formatElapsed } from '../../../hooks/useElapsed'
import { CARD_NOTE } from '../agentStyles'
import type { AgentTurnFooter } from '../types'

const BREAKDOWN = [
  ['chat', '对话'],
  ['image', '生图'],
  ['video', '生视频'],
] as const

export default function AgentTurnCost({ footer }: { footer: AgentTurnFooter }) {
  const [open, setOpen] = useState(false)
  const cost = footer.cost
  const total = cost ? agentTurnCostTotal(cost) : null

  const parts: ReactNode[] = []
  if (footer.durationMs !== undefined) {
    parts.push(<span>本轮耗时 {formatElapsed(footer.durationMs)}</span>)
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
