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
  if (total === 0) parts.push(<span>{failed ? t('cost.noCredits') : t('cost.free')}</span>)
  if (total) {
    // 限时免费期里这一轮的积分是「原价」：划掉它，紧跟一枚徽章说清为什么没收。
    // 只在整轮都来自对话时划总额；掺了生图/生视频的轮实付不为零，划总额就是谎。
    const freeChat = chatFree && cost !== undefined && cost.image === 0 && cost.video === 0
    parts.push(
      // 徽章紧贴着划掉的数字，中间不插分隔点：它解释的就是这个数，不是页脚的又一项。
      <span className="inline-flex items-center gap-1.5">
        <button
          type="button"
          aria-expanded={open}
          className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          {t('cost.spent')} <Credits credits={total} struck={freeChat} />
        </button>
        {freeChat && <ChatFreeMark />}
      </span>,
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
          {BREAKDOWN.filter(([key]) => cost[key] > 0).map(([key, labelKey], index) => {
            const amount = formatCount(cost[key])
            return (
              <Fragment key={key}>
                {index > 0 && <span aria-hidden="true"> · </span>}
                {t(labelKey)}{' '}
                {/* 混着生图/生视频的轮总额不划，免掉的那一项在明细里划掉自己的数字。 */}
                {chatFree && key === 'chat' ? (
                  <del className="decoration-1 opacity-60">{amount}</del>
                ) : (
                  amount
                )}
              </Fragment>
            )
          })}
        </span>
      )}
    </div>
  )
}

/** 限时免费只占一个图标位：页脚是给人扫一眼的，一行里塞不下第二段文字。 */
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
