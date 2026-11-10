import { defineMachine } from '../state-machine'

/**
 * `agent_batches.status`。
 * 确认可以从 draft，也可以从「改价 / 要重新确认」的 paused 再进入 running 或 paused。
 * 取消在若干写入点不读当前状态，所以终态也允许再写成 cancelled（幂等）。
 */
export const agentBatch = defineMachine({
  id: 'agent-batch',
  states: ['draft', 'running', 'paused', 'closed', 'cancelled'] as const,
  events: ['confirm', 'confirm_held', 'pause', 'resume', 'close', 'cancel'] as const,
  transitions: {
    draft: { confirm: 'running', confirm_held: 'paused', cancel: 'cancelled' },
    running: { pause: 'paused', close: 'closed', cancel: 'cancelled' },
    paused: {
      resume: 'running',
      confirm: 'running',
      confirm_held: 'paused',
      pause: 'paused',
      close: 'closed',
      cancel: 'cancelled',
    },
    closed: { cancel: 'cancelled' },
    cancelled: { cancel: 'cancelled' },
  },
})

export function agentBatchConfirmEvent(held: boolean): 'confirm' | 'confirm_held' {
  return held ? 'confirm_held' : 'confirm'
}
