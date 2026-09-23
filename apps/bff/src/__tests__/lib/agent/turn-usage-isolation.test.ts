import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent, AgentTurnUsage } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { completionStream, recordingAgentFetch } from '../../helpers/agentStubs'
import { type ChatCall, recordingChatFetch } from '../../helpers/chatStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_turn_usage')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_SUMMARY_MODEL = 'fixture-summary-model'
// 窗口要落在一条实测出来的带里：太低时固定开销（系统说明 + 工具清单，见 `request-budget.ts`）
// 装不下，出站硬闸把每一轮都拒掉，这个文件要测的用量无从产生；太高时留给消息的预算装得下
// 整段历史，压缩根本不触发，同样测不到东西。阈值 = 窗口 − 1500，所以带的下沿约等于
// 固定开销 + 1500。**每加一个工具，这一条都要跟着抬**：
// 2026-09-22 saveAsset / saveLook / viewImage.region 把开销抬到约 4000（窗口 5750）；
// 2026-09-23 editCanvasObject 抬到 4127，带随之上移到约 5630–6030，取中。
process.env.AGENT_CHAT_CONTEXT_WINDOW = '5880'
process.env.AGENT_CHAT_MAX_TOKENS = '500'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-compaction-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../../lib/chatCompletion'
)
// 这几条测试故意让上游 502/503：重试真退避要花掉一秒半墙钟，换不来任何确定性。
setChatRetryBackoffForTesting(0)
const { startAgentTurn } = await import('../../../lib/agent/turn')
const { turnExecution } = await import('../../../lib/agent/execution')
const { ANONYMOUS_AUDIENCE } = await import('../../../lib/agent/skills')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../../db/client')

type PreparedAgentTurn = import('../../../lib/agent/turn').PreparedAgentTurn

/**
 * 一份准备好的轮，只填这几条用例关心的：会话、轮 id、那一段历史与这一句话。起轮准备在
 * 真路径上给出的就是这个形状（见 `turn-preparation.ts`）。
 */
function prepared(
  conversationId: string,
  turnId: string,
  messages: readonly AgentMessageView[],
  text: string,
  settle?: PreparedAgentTurn['settle'],
): PreparedAgentTurn {
  return {
    // 这几条用例不领租约：断言的是用量与结算，写库走 db 自己的事务就够。
    execution: { assert: async () => {}, write: (callback) => db.transaction(callback) },
    conversationId,
    turnId,
    userMessageId: 'next',
    input: {
      history: {
        messages,
        coveredCount: 0,
        compaction: {
          summary: null,
          anchor: null,
          verbatim: null,
          failureCount: 0,
          openedAt: null,
        },
      },
      text,
      references: [],
      mode: 'image',
      reviewImageIds: [],
      autoSubmit: false,
      selectionHistoryStart: messages.length,
      audience: ANONYMOUS_AUDIENCE,
    },
    userId: null,
    deviceId: 'device-abcdefgh',
    ...(settle ? { settle } : {}),
  }
}

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
  const turn = await startAgentTurn(
    prepared(conversation.id, `turn-${history.length}`, history, '再来一张'),
  )
  let usage: AgentTurnUsage | null = null
  for await (const stored of turn.read(0)) {
    if (stored.event.type === 'turnEnd') usage = stored.event.usage
  }
  return usage
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setChatFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('startAgentTurn usage', () => {
  it('keeps the turn active until a transient settlement failure succeeds', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversation = await createAgentConversation(
      { kind: 'device', deviceId: 'device-abcdefgh' },
      '第一句',
    )
    let attempts = 0
    const turn = await startAgentTurn(
      prepared(conversation.id, 'turn-settlement-retry', [], '继续', async () => {
        attempts++
        if (attempts === 1) throw new Error('temporary ledger outage')
        return { chat: 0, image: 0, video: 0 }
      }),
    )

    for await (const _stored of turn.read(0)) {
      // Drain the turn through its durable terminal event.
    }
    expect(attempts).toBe(2)
  })

  it('leaves the compaction summary out of the turn usage', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const summaryCalls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(
        summaryCalls,
        () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(NARRATIVE) } }],
              usage: { prompt_tokens: 100, completion_tokens: 20 },
            }),
          ),
      ),
    )
    const conversation = await createAgentConversation(
      { kind: 'device', deviceId: 'device-abcdefgh' },
      '第一句',
    )

    const settlements: AgentTurnSettlement[] = []
    const turn = await startAgentTurn(
      prepared(conversation.id, 'turn-new', HISTORY, '再来一张', async (settlement) => {
        settlements.push(settlement)
        return { chat: 0, image: 0, video: 0 }
      }),
    )

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

    const summaryUsage = await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.purpose, 'compaction'))
    expect(summaryUsage).toHaveLength(1)
    expect(summaryUsage[0]).toMatchObject({
      conversation_id: conversation.id,
      turn_id: 'turn-new',
      device_id: 'device-abcdefgh',
      model: 'fixture-summary-model',
      status: 'completed',
      usage: { inputTokens: 100, outputTokens: 20 },
    })

    // 摘要只塑造送给模型的输入，不进事件流：轮事件表会原样发给前端。
    const streamed = JSON.stringify(events)
    for (const line of Object.values(NARRATIVE)) expect(streamed).not.toContain(line)
  })

  it('records every summary retry without billing its tokens to the conversation', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    let attempt = 0
    setChatFetchForTesting(
      recordingChatFetch([], () => {
        attempt += 1
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: attempt === 1 ? '不是 JSON' : JSON.stringify(NARRATIVE) } },
            ],
            usage: { prompt_tokens: attempt * 100, completion_tokens: attempt * 20 },
          }),
        )
      }),
    )

    expect(await usageOfTurnAfter(HISTORY)).toEqual({ inputTokens: 12, outputTokens: 4 })
    const records = await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.purpose, 'compaction'))
      .orderBy(schema.agent_model_calls.started_at)
    expect(records).toHaveLength(2)
    expect(records.map((record) => record.usage)).toEqual([
      { inputTokens: 100, outputTokens: 20 },
      { inputTokens: 200, outputTokens: 40 },
    ])
    expect(records[0]?.id).not.toBe(records[1]?.id)
  })

  it('records failed summary requests as unknown usage while the turn continues', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    setChatFetchForTesting(recordingChatFetch([], () => new Response('error', { status: 503 })))
    expect(await usageOfTurnAfter(HISTORY)).toEqual({ inputTokens: 12, outputTokens: 4 })
    const records = await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.purpose, 'compaction'))
    // 503 是瞬时故障，会退避重试，所以这里不止一行——每一次真实请求各记一条，这才是对的账。
    // 条数是重试预算说了算的，钉在这里只会把 `chatCompletion.ts` 的常量绑死在计费测试上。
    expect(records.length).toBeGreaterThan(1)
    expect(new Set(records.map((record) => record.id)).size).toBe(records.length)
    for (const record of records) expect(record).toMatchObject({ status: 'failed', usage: null })
  })

  it('bills one turn the same no matter how much history the transcript replays', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))

    const withoutHistory = await usageOfTurnAfter([])
    const withHistory = await usageOfTurnAfter(shortHistory(3))

    expect(withoutHistory).toEqual({ inputTokens: 12, outputTokens: 4 })
    expect(withHistory).toEqual(withoutHistory)
  })
})
