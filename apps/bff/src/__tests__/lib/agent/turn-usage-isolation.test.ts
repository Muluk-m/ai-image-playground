import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { completionStream, recordingAgentFetch } from '../../helpers/agentStubs'
import { type ChatCall, chatCompletion, recordingChatFetch } from '../../helpers/chatStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_turn_usage')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SUMMARY_MODEL = 'fixture-summary-model'
process.env.AGENT_CHAT_CONTEXT_WINDOW = '2000'
process.env.AGENT_CHAT_MAX_TOKENS = '500'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-compaction-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { setChatFetchForTesting } = await import('../../../lib/chatCompletion')
const { startAgentTurn } = await import('../../../lib/agent/turn')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb } = await import('../../../db/client')

const NARRATIVE = {
  completed: '出了三张马克杯图',
  inProgress: '在调背景色',
  decisions: '主体不换',
  artifacts: 'img-1',
}

/** 六条落库的历史，长到必然触发压缩。 */
const HISTORY: AgentMessageView[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((marker, index) => ({
  id: `m${index + 1}`,
  turnId: 'turn-old',
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: [{ type: 'text', text: marker.repeat(400) }],
  createdAt: 1,
}))

afterEach(() => {
  setAgentFetchForTesting()
  setChatFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('startAgentTurn usage', () => {
  it('leaves the compaction summary out of the turn usage', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const summaryCalls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(summaryCalls, () => chatCompletion(JSON.stringify(NARRATIVE))),
    )
    const conversation = await createAgentConversation(
      { kind: 'device', deviceId: 'device-abcdefgh' },
      '第一句',
    )

    const turn = await startAgentTurn({
      conversationId: conversation.id,
      turnId: 'turn-new',
      userMessageId: 'm7',
      history: HISTORY,
      text: '再来一张',
    })

    const events: AgentTurnEvent[] = []
    for await (const stored of turn.read(0)) events.push(stored.event)

    // 摘要真的调了，但那次请求的 token 不进这一轮：轮的用量只有对话补全那 12 / 4。
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]!.model).toBe('fixture-summary-model')
    const end = events.at(-1)!
    expect(end.type === 'turnEnd' && end.usage).toEqual({ inputTokens: 12, outputTokens: 4 })

    // 摘要只塑造送给模型的输入，不进事件流：轮事件表会原样发给前端。
    const streamed = JSON.stringify(events)
    for (const line of Object.values(NARRATIVE)) expect(streamed).not.toContain(line)
  })
})
