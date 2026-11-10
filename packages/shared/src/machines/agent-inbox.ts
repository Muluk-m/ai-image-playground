import type { AgentQueuedMessageState } from '../agent'
import { defineMachine } from '../state-machine'

/**
 * 会话收件箱一行的状态。新建（入队 / 抢先占位取消）不是转移。
 * `withdraw` 与 `return` 都能从 pending、failed 收到 cancelled，目的地相同，来源由调用点的 WHERE 限定。
 */
export const agentInbox = defineMachine({
  id: 'agent-inbox',
  states: ['pending', 'consumed', 'cancelled', 'failed'] as const,
  events: ['fail', 'consume', 'withdraw', 'skip', 'requeue', 'return'] as const,
  transitions: {
    pending: {
      fail: 'failed',
      consume: 'consumed',
      withdraw: 'cancelled',
      skip: 'cancelled',
      return: 'cancelled',
    },
    consumed: { requeue: 'pending' },
    cancelled: {},
    failed: { withdraw: 'cancelled', return: 'cancelled' },
  },
})

export const AGENT_INBOX_CREATED = {
  queued: 'pending',
  preempted: 'cancelled',
} as const satisfies Record<string, AgentQueuedMessageState>
