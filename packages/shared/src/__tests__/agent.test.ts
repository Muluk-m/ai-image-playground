import { describe, expect, it } from 'bun:test'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  type AgentTurnEvent,
  agentClarificationSummary,
  agentConversationTitle,
  agentHeartbeatFrame,
  agentMessageText,
  agentToolResultSummary,
  agentTurnCostTotal,
  canvasStageRunsDirectly,
  encodeAgentFrame,
  parseAgentFrame,
} from '../agent'

describe('canvasStageRunsDirectly', () => {
  it('defaults on unless the turn preference is explicitly off', () => {
    expect(canvasStageRunsDirectly(undefined)).toBe(true)
    expect(canvasStageRunsDirectly({})).toBe(true)
    expect(canvasStageRunsDirectly({ autoSubmit: true })).toBe(true)
    expect(canvasStageRunsDirectly({ autoSubmit: false })).toBe(false)
  })
})

describe('agentConversationTitle', () => {
  it('collapses whitespace in the first user message', () => {
    expect(agentConversationTitle('  把背景\n 换成浅木色  ')).toBe('把背景 换成浅木色')
  })

  it('drops markdown markers from a pasted script', () => {
    const script =
      '**漫剧名称：《折扇惊梦》**\n**场景：** 烟雨江南\n---\n- **谢云生：** 锦衣公子\n## 镜头 1'
    expect(agentConversationTitle(script)).toBe(
      '漫剧名称：《折扇惊梦》 场景： 烟雨江南 谢云生： 锦衣公子 镜头 1',
    )
  })

  it('keeps a message that is nothing but markdown markers', () => {
    expect(agentConversationTitle('---')).toBe('---')
  })

  it('truncates a long first message to the title budget', () => {
    const title = agentConversationTitle('好'.repeat(200))
    expect(title).toHaveLength(AGENT_CONVERSATION_TITLE_MAX_CHARS)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('agentMessageText', () => {
  it('joins the text blocks of a message', () => {
    const text = agentMessageText({
      id: 'm1',
      turnId: 't1',
      role: 'assistant',
      content: [
        { type: 'text', text: '好的，' },
        { type: 'text', text: '我来处理' },
      ],
      createdAt: 1,
    })
    expect(text).toBe('好的，我来处理')
  })
})

describe('confirmed generation instructions in model history', () => {
  it('keeps the edited instruction available after a confirmed job fails', () => {
    const prompt = '将浴缸换成白色，保留绿植。'
    const summary = agentToolResultSummary({
      type: 'toolResult',
      toolCallId: 'edit-bath',
      toolName: 'editImage',
      title: '换浴缸',
      status: 'failed',
      message: 'timeout',
      prompt,
      job: { taskId: 'confirmed-task', media: 'image' },
    })
    expect(summary).toContain(prompt)
  })

  it('does not replay an unconfirmed failed tool proposal as executed instructions', () => {
    const prompt = '未经确认的绿色浴缸方案'
    const summary = agentToolResultSummary({
      type: 'toolResult',
      toolCallId: 'failed-draft',
      toolName: 'editImage',
      title: '换浴缸',
      status: 'failed',
      prompt,
    })
    expect(summary).not.toContain(prompt)
  })

  it('replays historical canvas run proposals as inert records instead of granting execution', () => {
    const historical = JSON.parse(
      '{"type":"toolResult","toolCallId":"old-run","toolName":"runNodes","title":"运行节点","status":"succeeded","canvasRun":{"projectId":"project","nodeIds":["old-node"],"autoRun":true}}',
    )
    const summary = agentToolResultSummary(historical)
    expect(summary).toContain('旧运行建议仅供查看')
    expect(summary).toContain('重新提出阶段授权')
    expect(summary).not.toContain('已请求直接运行')
  })

  it('keeps the authorization lookup identity across model-history replay without claiming a submission', () => {
    const summary = agentToolResultSummary({
      type: 'toolResult',
      toolCallId: 'proposal',
      toolName: 'runNodes',
      title: '阶段授权',
      status: 'succeeded',
      canvasRun: {
        authorizationId: 'stage-lookup',
        projectId: 'project',
        stage: '素材',
        nodeIds: ['seed'],
        nodeNames: ['嫩芽'],
        estimatedCredits: 20,
        budgetCap: 20,
        status: 'pending',
      },
    })
    expect(summary).toContain('"authorizationId":"stage-lookup"')
    expect(summary).toContain('"nodeIds":["seed"]')
    expect(summary).toContain('当前状态必须查询')
    expect(summary).toContain('范围 嫩芽')
    expect(summary).toContain('待确认的提案')
  })

  it('tells the model a direct canvas run is already handed to the origin tab', () => {
    const summary = agentToolResultSummary({
      type: 'toolResult',
      toolCallId: 'proposal',
      toolName: 'runNodes',
      title: '阶段授权',
      status: 'succeeded',
      canvasRun: {
        authorizationId: 'stage-lookup',
        projectId: 'project',
        stage: '素材',
        nodeIds: ['seed'],
        nodeNames: ['嫩芽'],
        estimatedCredits: 20,
        budgetCap: 20,
        status: 'pending',
        direct: true,
      },
    })
    expect(summary).toContain('直接出图')
    expect(summary).toContain('无需用户确认')
    expect(summary).toContain('不要对用户说待确认、等待确认或等原标签页确认')
    expect(summary).not.toContain('待确认的提案')
  })

  it('does not tell the model a direct first-frame stage waits for a confirmation', () => {
    const canvasRun = {
      authorizationId: 'frames',
      projectId: 'project',
      stage: '首帧',
      nodeIds: ['grid'],
      nodeNames: ['首帧宫格'],
      estimatedCredits: 100,
      budgetCap: 100,
      status: 'pending' as const,
      storyboard: { storyboardId: 'board', shotCount: 2, totalSeconds: 9, shots: [] },
    }
    const block = {
      type: 'toolResult' as const,
      toolCallId: 'frames',
      toolName: 'runStoryboardFrames' as const,
      title: '首帧阶段',
      status: 'succeeded' as const,
    }
    const direct = agentToolResultSummary({ ...block, canvasRun: { ...canvasRun, direct: true } })
    expect(direct).toContain('开始运行即把分镜表（2 镜，共 9 秒）定稿')
    expect(direct).toContain('无需用户确认')
    expect(direct).not.toContain('确认这条授权')
    const manual = agentToolResultSummary({ ...block, canvasRun: { ...canvasRun, direct: false } })
    expect(manual).toContain('待确认的提案')
  })
})

describe('parseAgentFrame', () => {
  it('reads the event id back out of an encoded frame', () => {
    const frame = encodeAgentFrame(7, { type: 'textDelta', messageId: 'a1', delta: '好' })
    expect(parseAgentFrame(frame.trim())).toEqual({
      id: 7,
      event: { type: 'textDelta', messageId: 'a1', delta: '好' },
    })
  })

  it('reports a frame that carries no id', () => {
    const event: AgentTurnEvent = { type: 'assistantStart', messageId: 'a1' }
    expect(parseAgentFrame(`event: assistantStart\ndata: ${JSON.stringify(event)}`)).toEqual({
      id: null,
      event,
    })
  })

  it('drops a heartbeat comment and a malformed frame', () => {
    expect(parseAgentFrame(agentHeartbeatFrame().trim())).toBeNull()
    expect(parseAgentFrame('id: 3\ndata: {oops')).toBeNull()
  })
})

describe('agentClarificationSummary', () => {
  it('replays the question with its options on one line', () => {
    const line = agentClarificationSummary({
      type: 'clarification',
      question: '要哪种风格？',
      options: ['写实照片', '扁平插画'],
    })
    expect(line).toBe('向用户提问：要哪种风格？（选项：写实照片 / 扁平插画）')
  })
})

describe('agentTurnCostTotal', () => {
  it('sums the per-kind breakdown into the one number the footer shows', () => {
    expect(agentTurnCostTotal({ chat: 42, image: 85, video: 0 })).toBe(127)
    expect(agentTurnCostTotal({ chat: 0, image: 100, video: 0, chatWaived: 20 })).toBe(100)
  })

  it('counts a chat-only turn', () => {
    expect(agentTurnCostTotal({ chat: 60, image: 0, video: 0 })).toBe(60)
  })
})
