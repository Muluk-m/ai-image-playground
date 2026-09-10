import { describe, expect, it } from 'bun:test'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  agentConversationTitle,
  agentMessageText,
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
