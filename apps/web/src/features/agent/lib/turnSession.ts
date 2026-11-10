import type { AgentTurnStatus } from '../types'

/**
 * 面板上「这一轮在不在跑」的显式视图。
 * store 仍把 `turn`、`stopping`、`reconnecting` 分开放；idle 时残留的 reconnecting
 * 在这层丢掉，因为连接提示只在 running 时读它。写入点还没收成一个 reducer。
 */
export type AgentTurnSession =
  | { readonly phase: 'idle' }
  | { readonly phase: 'failed' }
  | {
      readonly phase: 'running'
      readonly stream: 'live' | 'reconnecting'
      readonly stop: 'idle' | 'requested'
    }

export function agentTurnSession(input: {
  readonly turn: AgentTurnStatus
  readonly stopping: boolean
  readonly reconnecting: boolean
}): AgentTurnSession {
  if (input.turn === 'idle') return { phase: 'idle' }
  if (input.turn === 'failed') return { phase: 'failed' }
  return {
    phase: 'running',
    stream: input.reconnecting ? 'reconnecting' : 'live',
    stop: input.stopping ? 'requested' : 'idle',
  }
}
