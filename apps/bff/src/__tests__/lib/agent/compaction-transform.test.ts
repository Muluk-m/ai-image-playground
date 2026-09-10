import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { resetTestDatabase } from '@image-playground/db/testing'
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
const { setChatFetchForTesting } = await import('../../../lib/chatCompletion')
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

describe('createCompactionTransform', () => {
  it('folds the old messages and stores the anchor on the conversation', async () => {
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))
    const id = await conversationId()
    const transform = createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
    })

    const shaped = await transform(MESSAGES)

    expect(shaped.length).toBeLessThan(MESSAGES.length)
    expect(await loadAgentCompaction(id)).toEqual({
      summary: NARRATIVE,
      anchor: { lastMessageId: 'm2', coveredCount: 2 },
      foldCount: 0,
      failureCount: 0,
      openedAt: null,
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
    })(MESSAGES)

    const summaryCalls: ChatCall[] = []
    setChatFetchForTesting(
      recordingChatFetch(summaryCalls, () => new Response('nope', { status: 502 })),
    )

    // 第二轮的尾巴便宜到摘要 + 尾巴装得下：这一态不该再调模型。
    const shaped = await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-2',
      historyIds: [...HISTORY_IDS, 'm6'],
      userMessageId: 'm7',
    })([...MESSAGES.slice(0, 5), user('m7', '好的').message])

    expect(summaryCalls).toHaveLength(0)
    expect(JSON.stringify(shaped[0])).toContain('出了三张马克杯图')
  })

  it('counts a failed summary toward the breaker and still returns a usable context', async () => {
    setChatFetchForTesting(chatFetchReturning(new Response('nope', { status: 502 })))
    const id = await conversationId()

    const shaped = await createCompactionTransform({
      conversationId: id,
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
    })(MESSAGES)

    expect(shaped.length).toBeGreaterThan(0)
    expect(await loadAgentCompaction(id)).toMatchObject({ summary: null, failureCount: 1 })
  })

  it('still hands back a usable context when the conversation row is gone', async () => {
    const transform = createCompactionTransform({
      conversationId: 'missing-conversation',
      turnId: 'turn-1',
      historyIds: HISTORY_IDS,
      userMessageId: 'm6',
    })
    setChatFetchForTesting(chatFetchReturning(chatCompletion(JSON.stringify(NARRATIVE))))

    expect((await transform(MESSAGES)).length).toBeGreaterThan(0)
  })
})
