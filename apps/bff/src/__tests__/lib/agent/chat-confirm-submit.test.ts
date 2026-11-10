import { expect, it } from 'bun:test'

process.env.DATABASE_URL = 'postgres://unused/chat-confirm-submit'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { shouldSubmitChatConfirmation } = await import('../../../lib/agent/chat-confirm-submit')

it('submits a short confirmation only when it is not a new request', () => {
  expect(shouldSubmitChatConfirmation({ text: '确认', referenceCount: 0 })).toBe(true)
  expect(shouldSubmitChatConfirmation({ text: '确认，执行生成', referenceCount: 0 })).toBe(true)
  expect(shouldSubmitChatConfirmation({ text: '换成狗', referenceCount: 0 })).toBe(false)
  expect(shouldSubmitChatConfirmation({ text: '确认', referenceCount: 1 })).toBe(false)
  expect(
    shouldSubmitChatConfirmation({ text: '确认', referenceCount: 0, clarificationAnswer: true }),
  ).toBe(false)
})
