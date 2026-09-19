import { describe, expect, it } from 'bun:test'
import type { AgentToolResultBlock } from '@image-playground/shared'
import { mergedWakePrompt, type WakeJob, wakeTurnPrompt } from '../../../lib/agent/wake-prompt'

function job(status: AgentToolResultBlock['status']): WakeJob {
  return {
    messageId: 'message-1',
    block: {
      type: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'editImage',
      status,
      title: '把天空改成晚霞',
      ...(status === 'succeeded'
        ? {
            artifacts: [
              {
                artifactId: 'artifact-1',
                media: 'image' as const,
                taskId: 'task-1',
                outputIndex: 0,
                mime: 'image/png',
              },
            ],
          }
        : { message: '上游超时' }),
      job: { taskId: 'task-1', media: 'image' },
    },
  }
}

describe('唤醒说明', () => {
  it('offers the deferred edits only on a wake turn of its own', () => {
    expect(wakeTurnPrompt([job('succeeded')])).toContain('可以用这些产物继续执行')
  })

  it('tells a merged turn to follow the new message instead of the earlier plan', () => {
    // 并进用户消息的那一轮不带提交时的改图计划，门禁会拒掉预先列明的后续编辑：说明里不能再提议。
    const merged = mergedWakePrompt([job('succeeded')])
    expect(merged).not.toContain('可以用这些产物继续执行')
    expect(merged).toContain('这一轮不要接着做')
    expect(merged).toContain('先回应用户这条消息')
  })

  it('leaves the plan out of a merged failure note', () => {
    const merged = mergedWakePrompt([job('failed')])
    expect(merged).toContain('失败（上游超时）')
    expect(merged).not.toContain('deferredEdits')
  })
})
