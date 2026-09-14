import { agentTurnCostTotal } from '@image-playground/shared'
import type { AgentTurnFooter } from '../types'

/** 会话合计只数结算过的轮：进行中的预扣还不是花掉的钱。 */
export function agentSessionCredits(turns: Readonly<Record<string, AgentTurnFooter>>): number {
  return Object.values(turns).reduce(
    (total, footer) => total + (footer.cost ? agentTurnCostTotal(footer.cost) : 0),
    0,
  )
}
