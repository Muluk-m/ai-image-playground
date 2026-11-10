import { defineMachine } from '../state-machine'

/**
 * `agent_batches.status`。
 * 确认可以从 draft，也可以从「改价 / 要重新确认」的 paused 再进入 running 或 paused。
 * 取消只发生在草稿，以及已经取消的草稿再写一次。执行中、暂停、已关闭不会被取消。
 * 删除会话时，除了 closed，其余（含 draft 和 cancelled）都会标成 paused，以便留下执行证据。
 */
export const agentBatch = defineMachine({
  id: 'agent-batch',
  states: ['draft', 'running', 'paused', 'closed', 'cancelled'] as const,
  events: ['confirm', 'confirm_held', 'pause', 'resume', 'close', 'cancel'] as const,
  transitions: {
    draft: { confirm: 'running', confirm_held: 'paused', pause: 'paused', cancel: 'cancelled' },
    running: { pause: 'paused', close: 'closed' },
    paused: {
      resume: 'running',
      confirm: 'running',
      confirm_held: 'paused',
      pause: 'paused',
      close: 'closed',
    },
    closed: {},
    cancelled: { pause: 'paused', cancel: 'cancelled' },
  },
})

export function agentBatchConfirmEvent(held: boolean): 'confirm' | 'confirm_held' {
  return held ? 'confirm_held' : 'confirm'
}
