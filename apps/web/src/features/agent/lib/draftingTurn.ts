import type { AgentPanelMessage, AgentTurnStatus } from '../types'

/**
 * 确认门拦下的稿，拟它的那一轮还在跑：同一段计划可能还没拟完，服务端此时也不收它的确认。
 * 和「用户发了新消息、新的一轮正在起」（稿随之作废）分开：那时跑着的是别的一轮。
 */
export function agentDraftStillDrafting(
  state: {
    readonly turn: AgentTurnStatus
    readonly activeTurn: { readonly turnId: string } | null
  },
  message: AgentPanelMessage,
): boolean {
  return (
    message.kind === 'tool' &&
    message.gated === true &&
    state.turn === 'running' &&
    state.activeTurn?.turnId === message.turnId
  )
}
