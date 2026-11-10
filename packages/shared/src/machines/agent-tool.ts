import { defineMachine } from '../state-machine'

/**
 * 已落库的工具结果卡。新建一张卡（直接 succeeded / failed / submitted / awaiting_confirmation）
 * 不是从空状态转出来的。`queued` 只出现在重试记录上。
 */
export const agentTool = defineMachine({
  id: 'agent-tool',
  states: ['awaiting_confirmation', 'queued', 'submitted', 'succeeded', 'failed'] as const,
  events: ['confirm', 'void', 'submit', 'succeed', 'fail', 'withdraw'] as const,
  transitions: {
    awaiting_confirmation: { confirm: 'submitted', void: 'failed' },
    queued: { submit: 'submitted', withdraw: 'failed' },
    submitted: { succeed: 'succeeded', fail: 'failed' },
    succeeded: {},
    failed: {},
  },
})

export type AgentToolEvent = (typeof agentTool.events)[number]
