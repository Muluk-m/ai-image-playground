import { describe, expect, it } from 'bun:test'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  type AgentTurnEvent,
  agentClarificationSummary,
  agentConversationTitle,
  agentHeartbeatFrame,
  agentMessageText,
  agentTurnCostTotal,
  encodeAgentFrame,
  parseAgentFrame,
} from '../agent'

describe('agentConversationTitle', () => {
  it('collapses whitespace in the first user message', () => {
    expect(agentConversationTitle('  把背景\n 换成浅木色  ')).toBe('把背景 换成浅木色')
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
  })

  it('counts a chat-only turn', () => {
    expect(agentTurnCostTotal({ chat: 60, image: 0, video: 0 })).toBe(60)
  })
})
