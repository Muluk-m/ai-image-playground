import { agentTurnCostTotal } from '@image-playground/shared'
import type { AgentTurnFooter } from '../types'

export function agentTurnCredits(footer: AgentTurnFooter): number | undefined {
  return footer.cost ? agentTurnCostTotal(footer.cost) : undefined
}

/** 会话合计只数结算过的轮：进行中的预扣还不是花掉的钱。 */
export function agentSessionCredits(turns: Readonly<Record<string, AgentTurnFooter>>): number {
  return Object.values(turns).reduce((total, footer) => total + (agentTurnCredits(footer) ?? 0), 0)
}

export function formatCredits(credits: number): string {
  return String(Math.round(credits)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function formatTurnDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
