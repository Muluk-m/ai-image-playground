import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_events')
process.env.PORT = '0'

const { appendAgentTurnEvents, lastAgentEventSeq, purgeOldAgentTurnEvents, readAgentTurnEvents } =
  await import('../../../lib/agent/events')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../../db/client')

const HOUR = 60 * 60 * 1_000

async function conversation(): Promise<string> {
  const view = await createAgentConversation({ kind: 'device', deviceId: 'device-abcdefgh' }, '')
  return view.id
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterAll(async () => {
  await closeDb()
})

describe('轮事件表', () => {
  it('序号在会话内单调递增，跨轮接着往下发', async () => {
    const conversationId = await conversation()
    await appendAgentTurnEvents(conversationId, 'turn-1', [
      { seq: 1, event: { type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' } },
      { seq: 2, event: { type: 'textDelta', messageId: 'a1', delta: '好' } },
    ])

    expect(await lastAgentEventSeq(conversationId)).toBe(2)

    await appendAgentTurnEvents(conversationId, 'turn-2', [
      { seq: 3, event: { type: 'turnStart', turnId: 'turn-2', userMessageId: 'u2' } },
    ])
    expect(await lastAgentEventSeq(conversationId)).toBe(3)
  })

  it('按轮和断点读回，只给断点之后的事件', async () => {
    const conversationId = await conversation()
    await appendAgentTurnEvents(conversationId, 'turn-1', [
      { seq: 1, event: { type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' } },
      { seq: 2, event: { type: 'textDelta', messageId: 'a1', delta: '好' } },
    ])
    await appendAgentTurnEvents(conversationId, 'turn-2', [
      { seq: 3, event: { type: 'turnStart', turnId: 'turn-2', userMessageId: 'u2' } },
    ])

    expect((await readAgentTurnEvents(conversationId, 'turn-1', 1)).map((one) => one.seq)).toEqual([
      2,
    ])
    expect(await readAgentTurnEvents(conversationId, 'turn-1', 2)).toEqual([])
    expect((await readAgentTurnEvents(conversationId, 'turn-2', 0)).map((one) => one.seq)).toEqual([
      3,
    ])
  })

  it('保留窗口之外的事件被清掉，窗口内的留着', async () => {
    const now = Date.now()
    const conversationId = await conversation()
    await appendAgentTurnEvents(
      conversationId,
      'turn-old',
      [{ seq: 1, event: { type: 'turnStart', turnId: 'turn-old', userMessageId: 'u1' } }],
      now - 30 * HOUR,
    )
    await appendAgentTurnEvents(
      conversationId,
      'turn-new',
      [{ seq: 2, event: { type: 'turnStart', turnId: 'turn-new', userMessageId: 'u2' } }],
      now - HOUR,
    )

    expect(await purgeOldAgentTurnEvents(24 * HOUR, now)).toBe(1)
    expect(await readAgentTurnEvents(conversationId, 'turn-old', 0)).toEqual([])
    expect(await readAgentTurnEvents(conversationId, 'turn-new', 0)).toHaveLength(1)
  })
})
