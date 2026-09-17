import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { StoredAgentEvent, TurnEventLog } from '../../../lib/agent/events'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_events')
process.env.PORT = '0'

const { appendAgentTurnEvents, openTurnEventLog, purgeOldAgentTurnEvents, readTurnEvents } =
  await import('../../../lib/agent/events')
const { createAgentConversation } = await import('../../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../../db/client')

const HOUR = 60 * 60 * 1_000

async function conversation(): Promise<string> {
  const view = await createAgentConversation({ kind: 'device', deviceId: 'device-abcdefgh' }, '')
  return view.id
}

/** 落库之后收流，跟 turn.ts 结束一轮的顺序一致。 */
async function finish(log: TurnEventLog): Promise<void> {
  await log.flush()
  log.close()
}

async function replayed(
  conversationId: string,
  turnId: string,
  afterSeq: number,
): Promise<StoredAgentEvent[]> {
  const feed = await readTurnEvents(conversationId, turnId, afterSeq)
  if (feed.kind !== 'replay') throw new Error(`expected replay, got ${feed.kind}`)
  return [...feed.events]
}

/** 实时流不会自己结束，取够就走。 */
async function take(
  events: AsyncGenerator<StoredAgentEvent>,
  count: number,
): Promise<StoredAgentEvent[]> {
  const taken: StoredAgentEvent[] = []
  for await (const one of events) {
    taken.push(one)
    if (taken.length === count) break
  }
  return taken
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterAll(async () => {
  await closeDb()
})

describe('轮事件日志', () => {
  it('序号接着会话既有的最大序号往下发，跨轮连续递增', async () => {
    const conversationId = await conversation()
    const first = await openTurnEventLog(conversationId, 'turn-1')
    first.emit({ type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' })
    first.emit({ type: 'textDelta', messageId: 'a1', delta: '好' })
    await finish(first)

    const second = await openTurnEventLog(conversationId, 'turn-2')
    second.emit({ type: 'turnStart', turnId: 'turn-2', userMessageId: 'u2' })
    second.emit({ type: 'textDelta', messageId: 'a2', delta: '的' })
    await finish(second)

    expect((await replayed(conversationId, 'turn-1', 0)).map((one) => one.seq)).toEqual([1, 2])
    expect((await replayed(conversationId, 'turn-2', 0)).map((one) => one.seq)).toEqual([3, 4])
  })

  it('轮在跑时从断点续读，拿到的是后续事件', async () => {
    const conversationId = await conversation()
    const live = await openTurnEventLog(conversationId, 'turn-1')
    live.emit({ type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' })
    live.emit({ type: 'textDelta', messageId: 'a1', delta: '好' })

    const feed = await readTurnEvents(conversationId, 'turn-1', 1)
    expect(feed.kind).toBe('live')
    if (feed.kind !== 'live') throw new Error('unreachable')

    const tail = take(feed.events, 2)
    live.emit({ type: 'textDelta', messageId: 'a1', delta: '的' })

    expect((await tail).map((one) => one.seq)).toEqual([2, 3])
    await finish(live)
  })

  it('轮结束之后同一个入口改走表，两次读取拿到同一段尾巴', async () => {
    const conversationId = await conversation()
    const live = await openTurnEventLog(conversationId, 'turn-1')
    live.emit({ type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' })
    live.emit({ type: 'textDelta', messageId: 'a1', delta: '好' })
    live.emit({
      type: 'turnEnd',
      turnId: 'turn-1',
      durationMs: 12,
      stopReason: 'completed',
      usage: null,
    })
    expect((await readTurnEvents(conversationId, 'turn-1', 1)).kind).toBe('live')

    await finish(live)

    const first = await replayed(conversationId, 'turn-1', 1)
    const second = await replayed(conversationId, 'turn-1', 1)
    expect(first.map((one) => one.seq)).toEqual([2, 3])
    expect(second).toEqual(first)
  })

  it('断点之后没有新事件不等于轮不存在', async () => {
    const conversationId = await conversation()
    const live = await openTurnEventLog(conversationId, 'turn-1')
    live.emit({ type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' })
    await finish(live)

    const feed = await readTurnEvents(conversationId, 'turn-1', 1)
    expect(feed.kind).toBe('replay')
    if (feed.kind !== 'replay') throw new Error('unreachable')
    expect(feed.events).toEqual([])
  })

  it('整轮都查不到才是没这一轮', async () => {
    const conversationId = await conversation()
    const live = await openTurnEventLog(conversationId, 'turn-1')
    live.emit({ type: 'turnStart', turnId: 'turn-1', userMessageId: 'u1' })
    await finish(live)

    expect((await readTurnEvents(conversationId, 'turn-missing', 0)).kind).toBe('no-such-turn')
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
    expect((await readTurnEvents(conversationId, 'turn-old', 0)).kind).toBe('no-such-turn')
    expect(await replayed(conversationId, 'turn-new', 0)).toHaveLength(1)
  })
})
