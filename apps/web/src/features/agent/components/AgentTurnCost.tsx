import { agentTurnCostTotal } from '@image-playground/shared'
import { Fragment, type ReactNode, useState } from 'react'
import Credits from '../../../components/Credits'
import { GiftIcon } from '../../../components/icons'
import ViewportTooltip from '../../../components/ViewportTooltip'
import { formatElapsed } from '../../../hooks/useElapsed'
import { useTooltip } from '../../../hooks/useTooltip'
import { useTranslation } from '../../../i18n'
import { formatCount } from '../../../i18n/format'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { CARD_NOTE } from '../agentStyles'
import type { AgentTurnFooter } from '../types'

const BREAKDOWN = [
  ['chat', 'label.chat'],
  ['image', 'cost.image'],
  ['video', 'cost.video'],
] as const

export default function AgentTurnCost({ footer }: { footer: AgentTurnFooter }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const cost = footer.cost
  const total = cost ? agentTurnCostTotal(cost) : null
  const chatFree = isClientCapabilityEnabled('billing:chat-free')

  // 进行中不写预扣：那是内部记账，用户只关心结算后的实际消耗；进行中由状态行表达。
  const parts: ReactNode[] = []
  const failed = footer.stopReason === 'failed'
  const waivedChat = chatFree && cost?.chat === 0 && !failed
  if (failed)
    parts.push(
      <span>
        {t(
          footer.error === 'agent_turn_interrupted'
            ? 'cost.interrupted'
            : // 这一份请求太大，服务端没有发它——说清是「没发出去」，不是「跑挂了」。
              footer.error === 'agent_context_overflow'
              ? 'cost.contextOverflow'
              : 'cost.failed',
        )}
      </span>,
    )
  // 停止后说了一半的回复照样留着，页脚标明它是被停下的，不是说完了。
  if (footer.stopReason === 'aborted') parts.push(<span>{t('cost.stopped')}</span>)
  if (footer.durationMs !== undefined) {
    parts.push(<span>{t('cost.duration', { duration: formatElapsed(footer.durationMs) })}</span>)
  }
  if (waivedChat && cost) {
    parts.push(
      <span className="inline-flex items-center gap-1">
        {t('cost.imageCredits')}{' '}
        {cost.image > 0 ? <Credits credits={cost.image} /> : t('cost.billedByTask')}
      </span>,
    )
    if (cost.video > 0)
      parts.push(
        <span className="inline-flex items-center gap-1">
          {t('cost.video')} <Credits credits={cost.video} />
        </span>,
      )
    parts.push(
      <span className="inline-flex items-center gap-1.5">
        <del className="decoration-1 opacity-70">{t('cost.chatCredits')}</del>
        <span>{t('cost.waived')}</span>
        <ChatFreeMark />
      </span>,
    )
  } else if (total === 0) parts.push(<span>{failed ? t('cost.noCredits') : t('cost.free')}</span>)
  if (total && !waivedChat) {
    parts.push(
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          {t('cost.spent')} <Credits credits={total} />
        </button>
      </span>,
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

/** 免费标记解释被划掉的对话积分。 */
function ChatFreeMark() {
  const { t } = useTranslation('agent')
  const tooltip = useTooltip()
  return (
    <span className="relative inline-flex">
      <span
        {...tooltip.handlers}
        tabIndex={0}
        role="img"
        aria-label={t('cost.chatFree')}
        className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 p-1 text-primary"
      >
        <GiftIcon className="h-3 w-3" />
      </span>
      <ViewportTooltip visible={tooltip.visible} className="whitespace-nowrap">
        {t('cost.chatFree')}
      </ViewportTooltip>
    </span>
  )
}
