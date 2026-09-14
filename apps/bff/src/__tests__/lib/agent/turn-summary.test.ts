import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_turn_summary')
process.env.PORT = '0'

const { listAgentTurnSummaries, recordAgentTurnSummary } = await import(
  '../../../lib/agent/turn-summary'
)
const { appendAgentTurnEvents, purgeOldAgentTurnEvents } = await import('../../../lib/agent/events')
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

describe('轮的持久事实', () => {
  it('按落库顺序给出每轮的耗时、停因与消耗', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary(
      {
        conversationId,
        turnId: 'turn-1',
        durationMs: 1_200,
        stopReason: 'completed',
        cost: { chat: 42, image: 85, video: 0 },
      },
      1_000,
    )
    await recordAgentTurnSummary(
      { conversationId, turnId: 'turn-2', durationMs: 300, stopReason: 'aborted' },
      2_000,
    )

    expect(await listAgentTurnSummaries(conversationId)).toEqual([
      {
        turnId: 'turn-1',
        durationMs: 1_200,
        stopReason: 'completed',
        cost: { chat: 42, image: 85, video: 0 },
      },
      { turnId: 'turn-2', durationMs: 300, stopReason: 'aborted' },
    ])
  })

  it('轮事件过了保留窗口被清掉，页脚照样读得到', async () => {
    const now = Date.now()
    const conversationId = await conversation()
    await appendAgentTurnEvents(
      conversationId,
      'turn-old',
      [
        {
          seq: 1,
          event: {
            type: 'turnEnd',
            turnId: 'turn-old',
            durationMs: 1_200,
            stopReason: 'completed',
            usage: null,
            cost: { chat: 42, image: 0, video: 0 },
          },
        },
      ],
      now - 30 * HOUR,
    )
    await recordAgentTurnSummary(
      {
        conversationId,
        turnId: 'turn-old',
        durationMs: 1_200,
        stopReason: 'completed',
        cost: { chat: 42, image: 0, video: 0 },
      },
      now - 30 * HOUR,
    )

    expect(await purgeOldAgentTurnEvents(24 * HOUR, now)).toBe(1)

    expect(await listAgentTurnSummaries(conversationId)).toEqual([
      {
        turnId: 'turn-old',
        durationMs: 1_200,
        stopReason: 'completed',
        cost: { chat: 42, image: 0, video: 0 },
      },
    ])
  })

  it('不计费的部署只留耗时，消耗那一项缺席', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 900,
      stopReason: 'completed',
    })

    const [summary] = await listAgentTurnSummaries(conversationId)
    expect(summary).toEqual({ turnId: 'turn-1', durationMs: 900, stopReason: 'completed' })
    expect(summary && 'cost' in summary).toBe(false)
  })

  it('同一轮重复收尾只覆盖，不堆出第二条页脚', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 900,
      stopReason: 'completed',
    })
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 1_500,
      stopReason: 'failed',
      cost: { chat: 0, image: 0, video: 0 },
    })

    expect(await listAgentTurnSummaries(conversationId)).toEqual([
      {
        turnId: 'turn-1',
        durationMs: 1_500,
        stopReason: 'failed',
        cost: { chat: 0, image: 0, video: 0 },
      },
    ])
  })

  it('会话删了，它的页脚跟着删', async () => {
    const conversationId = await conversation()
    await recordAgentTurnSummary({
      conversationId,
      turnId: 'turn-1',
      durationMs: 900,
      stopReason: 'completed',
    })

    await db.delete(schema.agent_conversations)

    expect(await listAgentTurnSummaries(conversationId)).toEqual([])
  })
})
