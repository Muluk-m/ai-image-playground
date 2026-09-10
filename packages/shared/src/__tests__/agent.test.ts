import { describe, expect, it } from 'bun:test'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  agentConversationTitle,
  agentHeartbeatFrame,
  agentMessageText,
  type AgentTurnEvent,
  encodeAgentFrame,
  isAgentTurnTerminal,
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

  it('joins multi-line data and reports a frame without an id', () => {
    const event = { type: 'error', error: 'agent_run_failed' }
    expect(parseAgentFrame(`event: error\ndata: ${JSON.stringify(event)}`)).toEqual({
      id: null,
      event: event as AgentTurnEvent,
    })
  })

  it('drops a heartbeat comment and a malformed frame', () => {
    expect(parseAgentFrame(agentHeartbeatFrame().trim())).toBeNull()
    expect(parseAgentFrame('id: 3\ndata: {oops')).toBeNull()
  })
})

describe('isAgentTurnTerminal', () => {
  it('treats turn end and error as the last event of a turn', () => {
    expect(
      isAgentTurnTerminal({ type: 'turnEnd', turnId: 't1', durationMs: 1, stopReason: 'completed' }),
    ).toBe(true)
    expect(isAgentTurnTerminal({ type: 'error', error: 'agent_upstream_error' })).toBe(true)
    expect(isAgentTurnTerminal({ type: 'textDelta', messageId: 'a1', delta: '好' })).toBe(false)
  })
})
