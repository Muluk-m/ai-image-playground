import { describe, expect, it } from 'vitest'
import {
  agentJobInbox,
  agentJobStep,
  agentToolProgress,
  formatElapsed,
  toolMessageForPlaceholder,
} from '../../../../features/agent/lib/jobProgress'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

const JOB = { taskId: 'task-1', media: 'image' as const }

function tool(patch: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    title: '一只橘猫',
    status: 'submitted',
    job: JOB,
    ...patch,
  }
}

describe('agentToolProgress', () => {
  it('walks a tool call through submitted, queued, generating and delivering', () => {
    expect(agentToolProgress(tool({ status: 'running' }), undefined, 5)).toEqual({
      phase: 'submitted',
      since: 5,
    })
    expect(agentToolProgress(tool({ status: 'running', stage: 'submitted' }))).toEqual({
      phase: 'queued',
    })
    expect(agentToolProgress(tool({ status: 'running', stage: 'running' }))?.phase).toBe(
      'generating',
    )
    expect(agentToolProgress(tool())?.phase).toBe('submitted')
    expect(agentToolProgress(tool(), { stage: 'submitted', submittedAt: 10 })).toEqual({
      phase: 'queued',
      since: 10,
    })
    expect(agentToolProgress(tool(), { stage: 'running', submittedAt: 10 })?.phase).toBe(
      'generating',
    )
    expect(
      agentToolProgress(tool({ status: 'succeeded', delivery: 'pending' }), {
        stage: 'running',
        submittedAt: 10,
      }),
    ).toEqual({ phase: 'delivering', since: 10 })
  })

  it('keeps the durable reconnecting and confirming phases from the server', () => {
    expect(
      agentToolProgress(tool(), { stage: 'submitted', submittedAt: 10, phase: 'reconnecting' }),
    ).toEqual({ phase: 'reconnecting', since: 10 })
    expect(
      agentToolProgress(tool(), { stage: 'running', submittedAt: 10, phase: 'reconnecting' })
        ?.phase,
    ).toBe('reconnecting')
    expect(
      agentToolProgress(tool(), { stage: 'running', submittedAt: 10, phase: 'confirming' })?.phase,
    ).toBe('confirming')
    // 刻度上两者都落在「生成」那一格。
    expect(agentJobStep('reconnecting')).toBe('generating')
    expect(agentJobStep('confirming')).toBe('generating')
    expect(agentJobStep('queued')).toBe('queued')
  })

  it('prefers the server submission time over the local start so every device agrees', () => {
    expect(agentToolProgress(tool(), { stage: 'running', submittedAt: 10 }, 99)?.since).toBe(10)
  })

  it('has no stages for a call that does not generate', () => {
    expect(agentToolProgress(tool({ status: 'running', toolName: 'readLibrary' }))).toBeNull()
  })

  it('has no progress once the call is over', () => {
    expect(agentToolProgress(tool({ status: 'succeeded', delivery: 'placed' }))).toBeNull()
    expect(agentToolProgress(tool({ status: 'failed', errorCode: 'cancelled' }))).toBeNull()
  })
})

it('formats elapsed time as m:ss and h:mm:ss', () => {
  expect(formatElapsed(0)).toBe('0:00')
  expect(formatElapsed(42_900)).toBe('0:42')
  expect(formatElapsed(125_000)).toBe('2:05')
  expect(formatElapsed(3_725_000)).toBe('1:02:05')
})

it('finds the result card of a local placeholder by message id and of a cloud one by task id', () => {
  const messages: AgentPanelMessage[] = [
    tool(),
    tool({ id: 'tool-2', job: { ...JOB, taskId: 'task-2' } }),
  ]
  expect(toolMessageForPlaceholder(messages, { messageId: 'tool-2' })?.id).toBe('tool-2')
  expect(toolMessageForPlaceholder(messages, { taskId: 'task-1' })?.id).toBe('tool-1')
  expect(toolMessageForPlaceholder(messages, { messageId: 'other' })).toBeNull()
})

it('splits the background jobs of a conversation into running and finished', () => {
  const inbox = agentJobInbox([
    tool(),
    tool({ id: 'tool-2', status: 'succeeded' }),
    tool({ id: 'tool-3', status: 'failed', errorCode: 'cancelled' }),
    // 不是后台任务的调用不进收件箱。
    tool({ id: 'tool-4', status: 'succeeded', job: undefined }),
  ])
  expect(inbox.running.map((one) => one.id)).toEqual(['tool-1'])
  expect(inbox.finished.map((one) => one.id)).toEqual(['tool-2', 'tool-3'])
  expect(inbox.completed).toBe(1)
})
