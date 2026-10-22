import { describe, expect, it } from 'bun:test'
import type { AgentMessageView, AgentToolResultBlock } from '@image-playground/shared'

// 只装配消息，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/tool-gate'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { agentToolGateActive, createAgentToolGate, gateContinuation } = await import(
  '../../../lib/agent/tool-gate'
)
const { promptAutoSubmit, turnInitialState } = await import('../../../lib/agent/turn-input')

function toolCall(name: string, id: string) {
  return {
    toolCall: { type: 'toolCall' as const, id, name, arguments: {} },
  } as unknown as Parameters<ReturnType<typeof createAgentToolGate>['beforeToolCall']>[0]
}

function gatedCard(overrides: Partial<AgentToolResultBlock> = {}): AgentToolResultBlock {
  return {
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    status: 'submitted',
    title: '一只橘猫',
    prompt: '一只戴围巾的橘猫',
    gated: true,
    snapshot: { mode: 'image', args: { prompt: '一只橘猫', n: 1 } },
    job: { taskId: 'task-1', media: 'image', outputCount: 1 },
    ...overrides,
  } as AgentToolResultBlock
}

function turnOf(...blocks: AgentToolResultBlock[]): AgentMessageView[] {
  return [
    {
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user',
      content: [{ type: 'text', text: '画一只橘猫' }],
      createdAt: 1,
    },
    {
      id: 'assistant-1',
      turnId: 'turn-1',
      role: 'assistant',
      content: [{ type: 'text', text: '我来画。' }, ...blocks],
      createdAt: 2,
    },
  ] as AgentMessageView[]
}

describe('确认门开不开', () => {
  it('只在智能体模式、用户显式关掉直接出图时开', () => {
    expect(agentToolGateActive('chat', { autoSubmit: false })).toBe(true)
    expect(agentToolGateActive('chat', { autoSubmit: true })).toBe(false)
    // 没带偏好的老请求维持原来的拟稿收尾。
    expect(agentToolGateActive('chat', {})).toBe(false)
    expect(agentToolGateActive('chat', undefined)).toBe(false)
    // 画布的阶段授权是第二阶段；原话直出与制作模式不归这里。
    expect(agentToolGateActive('canvas', { autoSubmit: false })).toBe(false)
    expect(agentToolGateActive('chat', { autoSubmit: false, directImage: true })).toBe(false)
    expect(agentToolGateActive('chat', { autoSubmit: false, productionMode: true })).toBe(false)
  })

  it('开门时系统提示词与直接出图逐字相同：智能体不知道有这道门', () => {
    expect(promptAutoSubmit({ autoSubmit: false, toolGate: true })).toBe(true)
    expect(promptAutoSubmit({ autoSubmit: false })).toBe(false)
  })
})

describe('beforeToolCall', () => {
  it('只认出生图、改图、生视频，从不拦成错误结果', async () => {
    const gate = createAgentToolGate(true)
    for (const [name, id] of [
      ['generateImage', 'a'],
      ['editImage', 'b'],
      ['generateVideo', 'c'],
      ['webSearch', 'd'],
    ] as const)
      expect(await gate.beforeToolCall(toolCall(name, id))).toBeUndefined()
    expect(['a', 'b', 'c', 'd'].map((id) => gate.view.holds(id))).toEqual([true, true, true, false])
  })

  it('门没开时什么都不认', async () => {
    const gate = createAgentToolGate(false)
    await gate.beforeToolCall(toolCall('generateImage', 'a'))
    expect(gate.view.holds('a')).toBe(false)
  })
})

describe('续跑接在历史末尾的那一对', () => {
  it('调用用模型当时的参数，回执用用户确认的提示词；没确认的、不是门拦下的都不接', () => {
    const turn = turnOf(
      gatedCard(),
      gatedCard({ toolCallId: 'call-2', status: 'awaiting_confirmation', job: undefined }),
      gatedCard({ toolCallId: 'call-3', gated: undefined }),
    )
    const { calls } = gateContinuation(turn)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      toolCallId: 'call-1',
      toolName: 'generateImage',
      args: { prompt: '一只橘猫', n: 1 },
    })
    expect(calls[0]!.result).toContain('已按用户要求提交')
    expect(calls[0]!.result).toContain('一只戴围巾的橘猫')
  })

  it('回放里那张卡不再按文字回放，而是在末尾接成一次真实的调用与结果', () => {
    const turn = turnOf(gatedCard())
    const continuation = gateContinuation(turn)
    const { messages } = turnInitialState(
      turn,
      'image',
      true,
      turn.length,
      undefined,
      undefined,
      false,
      continuation,
    )
    const tail = messages.slice(-2)
    expect(tail[0]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call-1', name: 'generateImage' }],
    })
    expect(tail[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1', isError: false })
    // 回放的文字里不再出现那张卡：同一次调用不会说两遍。
    const replayedText = JSON.stringify(messages.slice(0, -2))
    expect(replayedText).toContain('我来画。')
    expect(replayedText).not.toContain('task-1')
    expect(replayedText).not.toContain('一只戴围巾的橘猫')
  })
})
