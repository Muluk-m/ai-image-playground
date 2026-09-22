import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentCompactionRecord } from '@image-playground/shared'
import { assistant, body, user } from '../../helpers/agentMessages'
import {
  type ChatCall,
  chatCompletion,
  chatFetchReturning,
  recordingChatFetch,
} from '../../helpers/chatStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_compaction')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_CHAT_CONTEXT_WINDOW = '2000'
process.env.AGENT_CHAT_MAX_TOKENS = '500'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../../agent-compaction-operator-config.json',
)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../../lib/chatCompletion'
)
// 这几条测试故意让上游 502/503：重试真退避要花掉一秒半墙钟，换不来任何确定性。
setChatRetryBackoffForTesting(0)
const { createCompactionTransform } = await import('../../../lib/agent/compaction-transform')
const { createAgentConversation, loadAgentCompaction } = await import(
  '../../../lib/agent/conversations'
)
const { close: closeDb, db, schema } = await import('../../../db/client')

const NARRATIVE = {
  completed: '出了三张马克杯图',
  inProgress: '在调背景色',
  decisions: '主体不换',
  artifacts: 'img-1',
}

const DEVICE = { kind: 'device', deviceId: 'device-abcdefgh' } as const

/** 五条落库的历史 + 本轮那条用户消息，正好越过阈值。 */
const HISTORY_IDS = ['m1', 'm2', 'm3', 'm4', 'm5']
const MESSAGES: AgentMessage[] = [
  user('m1', body('a')),
  assistant('m2', body('b')),
  user('m3', body('c')),
  assistant('m4', body('d')),
  user('m5', body('e')),
  user('m6', body('f')),
].map((entry) => entry.message)

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setChatFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

async function conversationId(): Promise<string> {
  const conversation = await createAgentConversation(DEVICE, '第一句')
  return conversation.id
}

/** 没有摘要时的起手记录：存储层对一个新会话给出的就是这一份。 */
const FRESH: AgentCompactionRecord = {
  summary: null,
  anchor: null,
  verbatim: null,
  failureCount: 0,
  openedAt: null,
}

describe('createCompactionTransform', () => {
  it('folds the old messages and stores the anchor on the conversation', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))
    const id = await conversationId()
    const transform = createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
      compaction: FRESH,
      foldedBefore: 0,
      overheadTokens: 0,
    })

    const shaped = await transform(MESSAGES)

    expect(shaped.length).toBeLessThan(MESSAGES.length)
    expect(await loadAgentCompaction(id)).toEqual({
      summary: NARRATIVE,
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      verbatim: { omittedCount: 0, omittedChars: 0, kept: [body('a')] },
      failureCount: 0,
      openedAt: null,
    })
  })

  // 落回去的锚点必须是绝对位置：存储层拿 `coveredCount` 与活着的条数比对来发现「中间某条
  // 被删」。写成局部条数的话，一个折过一次的会话每一轮都会被判成锚点失配，白重做。
  it('writes the anchor in absolute terms when earlier messages were never loaded', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))
    const id = await conversationId()

    await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
      compaction: FRESH,
      foldedBefore: 40,
      overheadTokens: 0,
    })(MESSAGES)

    expect((await loadAgentCompaction(id))?.anchor).toEqual({
      lastMessageId: 'm2',
      coveredCount: 42,
    })
  })

  it('reuses the stored summary on the next turn without calling the model', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))
    const id = await conversationId()
    await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
      compaction: FRESH,
      foldedBefore: 0,
      overheadTokens: 0,
    })(MESSAGES)
    const stored = await loadAgentCompaction(id)

    const summaryCalls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(summaryCalls, () => new Response('nope', { status: 502 })),
    )

    // 第二轮起轮时窗口已经跳过折进去的那两条，摘要 + 剩下的尾巴装得下：不该再调模型，
    // 而摘要必须仍然在最前面——锚点之前的原文这一轮根本没读出来。
    const shaped = await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-2',
      historyIds: ['m3', 'm4', 'm5'],
      userMessageId: 'm6',
      compaction: stored!,
      foldedBefore: 2,
      overheadTokens: 0,
    })([...MESSAGES.slice(2, 5), user('m6', '好的').message])

    expect(summaryCalls).toHaveLength(0)
    expect(JSON.stringify(shaped[0])).toContain('出了三张马克杯图')
  })

  // 折进摘要的那些原文下一轮就不会再读出来了，用户原话只能靠存档接力。
  it('carries the archived user text into the next turn', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))
    const id = await conversationId()
    await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
      compaction: FRESH,
      foldedBefore: 0,
      overheadTokens: 0,
    })(MESSAGES)

    // 这一轮还得再折一次：折的是窗口里的消息，而存档里那句原文早就不在窗口里了。
    const shaped = await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-2',
      historyIds: ['m3', 'm4', 'm5', 'm6', 'm7'],
      userMessageId: 'm8',
      compaction: (await loadAgentCompaction(id))!,
      foldedBefore: 2,
      overheadTokens: 0,
    })([...MESSAGES.slice(2, 6), user('m7', body('g')).message, user('m8', body('h')).message])

    expect(JSON.stringify(shaped[0])).toContain(body('a'))
  })

  it('counts a failed summary toward the breaker and still returns a usable context', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('nope', { status: 502 })))
    const id = await conversationId()

    const shaped = await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
      compaction: FRESH,
      foldedBefore: 0,
      overheadTokens: 0,
    })(MESSAGES)

    expect(shaped.length).toBeGreaterThan(0)
    expect(await loadAgentCompaction(id)).toMatchObject({ summary: null, failureCount: 1 })
  })

  // 系统说明与工具清单也占窗口：消息能占的那份预算要先把它们让出来，否则消息刚好卡在
  // 阈值上、加上开销就超了出站硬闸。
  it('固定开销越大，留给消息的预算越小', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('nope', { status: 502 })))
    const shapedWith = async (overheadTokens: number) =>
      createCompactionTransform({
        conversationId: await conversationId(),
        turnId: 'turn-1',
        historyIds: HISTORY_IDS,
        userMessageId: 'm6',
        compaction: FRESH,
        foldedBefore: 0,
        overheadTokens,
      })(MESSAGES)

    expect((await shapedWith(300)).length).toBeLessThan((await shapedWith(0)).length)
  })
})
