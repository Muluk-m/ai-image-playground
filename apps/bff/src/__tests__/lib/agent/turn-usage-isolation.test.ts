import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent, AgentTurnUsage } from '@image-playground/shared'
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
type AgentTurnSettlement = import('../../../lib/agent/turn').AgentTurnSettlement

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

/** 短到不会触发压缩的历史，用户与助手各占一半。 */
function shortHistory(pairs: number): AgentMessageView[] {
  return Array.from({ length: pairs * 2 }, (_, index) => ({
    id: `h${index + 1}`,
    turnId: 'turn-old',
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: [{ type: 'text' as const, text: `第${index + 1}句` }],
    createdAt: 1,
  }))
}

async function usageOfTurnAfter(history: AgentMessageView[]): Promise<AgentTurnUsage | null> {
  const conversation = await createAgentConversation(
    { kind: 'device', deviceId: 'device-abcdefgh' },
    '第一句',
  )
  const turn = await startAgentTurn({
    conversationId: conversation.id,
    turnId: `turn-${history.length}`,
    userMessageId: 'next',
    history,
    text: '再来一张',
    references: [],
    userId: null,
    deviceId: 'device-abcdefgh',
  })
  let usage: AgentTurnUsage | null = null
  for await (const stored of turn.read(0)) {
    if (stored.event.type === 'turnEnd') usage = stored.event.usage
  }
  return usage
}

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

    const settlements: AgentTurnSettlement[] = []
    const turn = await startAgentTurn({
      conversationId: conversation.id,
      turnId: 'turn-new',
      userMessageId: 'm7',
      history: HISTORY,
      references: [],
      text: '再来一张',
      userId: null,
      deviceId: 'device-abcdefgh',
      settle: async (settlement) => {
        settlements.push(settlement)
      },
    })

    const events: AgentTurnEvent[] = []
    for await (const stored of turn.read(0)) events.push(stored.event)

    // 摘要真的调了，但那次请求的 token 不进这一轮：轮的用量只有对话补全那 12 / 4。
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]!.model).toBe('fixture-summary-model')
    const end = events.at(-1)!
    expect(end.type === 'turnEnd' && end.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
    // 结算读的是同一份用量：摘要那次请求不进任何一轮的账。
    expect(settlements).toEqual([
      {
        outcome: 'completed',
        usage: { inputTokens: 12, outputTokens: 4 },
        upstreamInvocationCount: 1,
      },
    ])

    // 摘要只塑造送给模型的输入，不进事件流：轮事件表会原样发给前端。
    const streamed = JSON.stringify(events)
    for (const line of Object.values(NARRATIVE)) expect(streamed).not.toContain(line)
  })

  /**
   * 用量按转录里的助手消息累加，而转录的前缀是回放进来的历史。历史那几条的用量是占位零，
   * 一旦有人把每条消息的用量持久化下来、加载时还原回去，这个循环就会把旧账再算一遍。
   */
  it('bills one turn the same no matter how much history the transcript replays', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))

    const withoutHistory = await usageOfTurnAfter([])
    const withHistory = await usageOfTurnAfter(shortHistory(3))

    expect(withoutHistory).toEqual({ inputTokens: 12, outputTokens: 4 })
    expect(withHistory).toEqual(withoutHistory)
  })
})
