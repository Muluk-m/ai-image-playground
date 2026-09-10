import { agentTurnCostTotal } from '@image-playground/shared'
import type { AgentTurnFooter } from '../types'

/** 会话合计只数结算过的轮：进行中的预扣还不是花掉的钱。 */
export function agentSessionCredits(turns: Readonly<Record<string, AgentTurnFooter>>): number {
  return Object.values(turns).reduce(
    (total, footer) => total + (footer.cost ? agentTurnCostTotal(footer.cost) : 0),
    0,
  )
}

export function formatCredits(credits: number): string {
  return Math.round(credits).toLocaleString('en-US')
}

/** 原型定的写法是 `1m 10s`，与 useElapsed 的 `1:10` 是两种口径，不要互相替换。 */
export function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
