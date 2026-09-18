import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationSnapshot,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  parseFrames,
  type ReceivedFrame,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_session_events')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { appendAgentTurnEvents, SEAL_SEQ_GAP } = await import('../../lib/agent/events')
const { AGENT_EXECUTION_LEASE_MS, agentInstance } = await import('../../lib/agent/execution')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

async function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const opened: string[] = []

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const json = (await response.json()) as { conversation: { id: string } }
  opened.push(json.conversation.id)
  return json.conversation.id
}

function startTurn(conversationId: string, text: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, { deviceId: DEVICE, text })
}

function withLastEventId(lastEventId?: number): Headers {
  const headers = new Headers({ [DEVICE_ID_HEADER]: DEVICE })
  if (lastEventId !== undefined) headers.set('last-event-id', String(lastEventId))
  return headers
}

/** 会话级增量：跨轮、按会话内序号。 */
async function conversationEvents(
  conversationId: string,
  lastEventId?: number,
): Promise<ReceivedFrame[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/events`, {
      headers: withLastEventId(lastEventId),
    }),
  )
  expect(response.status).toBe(200)
  return parseFrames(await response.text())
}

async function turnEvents(conversationId: string, turnId: string): Promise<ReceivedFrame[]> {
  const response = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/turns/${turnId}/events`,
      { headers: withLastEventId() },
    ),
  )
  expect(response.status).toBe(200)
  return parseFrames(await response.text())
}

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  return (await response.json()) as AgentConversationSnapshot
}

/** 跑完一整轮，返回起轮那条流上的全部帧。 */
async function completeTurn(conversationId: string, text: string, reply: string) {
  const live = startTurn(conversationId, text)
  upstream.push(reply)
  upstream.finish()
  const frames = parseFrames(await (await live).text())
  upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => upstream.responseFor(signal)))
  return frames
}

const types = (frames: readonly ReceivedFrame[]) => frames.map((frame) => frame.event.type)
const ids = (frames: readonly ReceivedFrame[]) => frames.map((frame) => frame.id)
const increasing = (values: readonly (number | null)[]) =>
  values.every((value, index) => index === 0 || (value ?? 0) > (values[index - 1] ?? 0))

/** 被打断的轮只落了三条，终帧跳过进程死前可能已经流出去、却没落库的那段序号。 */
const SEALED_SEQ = 3 + SEAL_SEQ_GAP

/** 进程被杀的那一刻：事件落了一半、没有终帧，租约过了期没人续。 */
async function seedInterruptedTurn(conversationId: string, turnId: string, afterSeq = 0) {
  const events: AgentTurnEvent[] = [
    { type: 'turnStart', turnId, userMessageId: `${turnId}-user` },
    { type: 'assistantStart', messageId: `${turnId}-assistant` },
    { type: 'textDelta', messageId: `${turnId}-assistant`, delta: '好的，我先' },
  ]
  const now = Date.now()
  await appendAgentTurnEvents(
    conversationId,
    turnId,
    events.map((event, index) => ({ seq: afterSeq + index + 1, event })),
    now - 2 * AGENT_EXECUTION_LEASE_MS,
  )
  await db.insert(schema.agent_executions).values({
    conversation_id: conversationId,
    turn_id: turnId,
    instance: 'crashed-instance',
    origin: 'http://crashed.test',
    state: 'running',
    heartbeat_at: now - 2 * AGENT_EXECUTION_LEASE_MS,
  })
}

let upstream: ControlledCompletion
let calls: AgentCall[]

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  calls = []
  upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => upstream.responseFor(signal)))
})

afterEach(async () => {
  for (const conversationId of opened.splice(0)) {
    const { activeTurn } = await snapshot(conversationId)
    if (!activeTurn) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${activeTurn.turnId}/abort`, {
      deviceId: DEVICE,
    })
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null)
  }
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('会话级事件流', () => {
  it('每一轮都以开始事件起、以终止事件收，序号在会话内连续', async () => {
    const conversationId = await startConversation()
    await completeTurn(conversationId, '你好', '好的')
    await completeTurn(conversationId, '再来', '收到')

    const frames = await conversationEvents(conversationId)

    expect(ids(frames)).toEqual(frames.map((_, index) => index + 1))
    const starts = frames.filter((frame) => frame.event.type === 'turnStart')
    const ends = frames.filter((frame) => frame.event.type === 'turnEnd')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(frames[0]!.event.type).toBe('turnStart')
    expect(frames.at(-1)!.event.type).toBe('turnEnd')
  })

  it('从断点跨轮续播：先补完上一轮的尾巴，再接着正在跑的这一轮，不重不漏', async () => {
    const conversationId = await startConversation()
    const first = await completeTurn(conversationId, '你好', '好的')
    const live = startTurn(conversationId, '再来')
    upstream.push('收到')
    const opening = await readFrames(await live, 3)

    const resumed = app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/events`, {
        headers: withLastEventId(2),
      }),
    )
    upstream.push('，这就画')
    upstream.finish()
    const rest = parseFrames(await (await resumed).text())

    expect(rest[0]!.id).toBe(3)
    expect(ids(rest)).toEqual(rest.map((_, index) => index + 3))
    // 上一轮剩下的尾巴、这一轮已经发过的开头与之后的增量，一条不少也一条不多。
    expect(rest.slice(0, first.length - 2)).toEqual(first.slice(2))
    expect(rest.slice(first.length - 2, first.length - 2 + opening.length)).toEqual(opening)
    expect(rest.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  })

  it('断点已经追平且没有轮在跑时，增量是空的', async () => {
    const conversationId = await startConversation()
    const frames = await completeTurn(conversationId, '你好', '好的')

    expect(await conversationEvents(conversationId, frames.at(-1)!.id!)).toEqual([])
  })
})

describe('服务端补写终帧', () => {
  it('被打断的轮在读取时补上失败的终帧，快照、会话增量与按轮续播一致', async () => {
    const conversationId = await startConversation()
    await seedInterruptedTurn(conversationId, 'turn-crashed')

    const state = await snapshot(conversationId)
    expect(state.activeTurn).toBeNull()
    expect(state.cursor).toBe(SEALED_SEQ)
    expect(state.turns).toEqual([
      expect.objectContaining({ turnId: 'turn-crashed', stopReason: 'failed' }),
    ])

    const frames = await conversationEvents(conversationId)
    expect(ids(frames)).toEqual([1, 2, 3, SEALED_SEQ])
    expect(frames.at(-1)!.event).toMatchObject({
      type: 'turnEnd',
      turnId: 'turn-crashed',
      stopReason: 'failed',
      error: 'agent_run_failed',
    })
    expect(await turnEvents(conversationId, 'turn-crashed')).toEqual(frames)

    // 补写只发生一次：再读不会多出第二个终帧。
    expect(await conversationEvents(conversationId)).toEqual(frames)
  })

  it('按轮续播直接撞上被打断的轮也能读到终帧，不会一直等下去', async () => {
    const conversationId = await startConversation()
    await seedInterruptedTurn(conversationId, 'turn-crashed')

    const frames = await turnEvents(conversationId, 'turn-crashed')

    expect(types(frames)).toEqual(['turnStart', 'assistantStart', 'textDelta', 'turnEnd'])
    expect(frames.at(-1)!.id).toBe(SEALED_SEQ)
  })

  it('进程死前流出去却没落库的尾巴不会让终帧撞号：带着更大的断点续播仍能收到终帧', async () => {
    const conversationId = await startConversation()
    // 表里只有 1..3，客户端却已经从内存实时流里收到了 4..7。
    await seedInterruptedTurn(conversationId, 'turn-crashed')

    const frames = await conversationEvents(conversationId, 7)

    expect(frames).toEqual([
      {
        id: SEALED_SEQ,
        event: expect.objectContaining({
          type: 'turnEnd',
          turnId: 'turn-crashed',
          stopReason: 'failed',
        }),
      },
    ])
    const next = await completeTurn(conversationId, '再来', '好的')
    expect(next[0]).toMatchObject({ id: SEALED_SEQ + 1, event: { type: 'turnStart' } })
  })

  it('页脚已经落了、终帧没发出去的轮，补写照页脚的结局与消耗', async () => {
    const conversationId = await startConversation()
    await seedInterruptedTurn(conversationId, 'turn-crashed')
    const cost = { chat: 3, image: 12, video: 0 }
    await db.insert(schema.agent_turns).values({
      conversation_id: conversationId,
      turn_id: 'turn-crashed',
      duration_ms: 4321,
      stop_reason: 'completed',
      cost,
      created_at: Date.now(),
    })

    const frames = await conversationEvents(conversationId)

    expect(frames.at(-1)).toEqual({
      id: SEALED_SEQ,
      event: {
        type: 'turnEnd',
        turnId: 'turn-crashed',
        durationMs: 4321,
        stopReason: 'completed',
        usage: null,
        cost,
      },
    })
    expect((await snapshot(conversationId)).turns).toEqual([
      expect.objectContaining({ turnId: 'turn-crashed', stopReason: 'completed', cost }),
    ])
  })

  it('下一轮开始前先补上一轮的终帧，终帧排在新一轮之前', async () => {
    const conversationId = await startConversation()
    await seedInterruptedTurn(conversationId, 'turn-crashed')

    const next = await completeTurn(conversationId, '再来', '好的')

    expect(next[0]).toMatchObject({ id: SEALED_SEQ + 1, event: { type: 'turnStart' } })
    const frames = await conversationEvents(conversationId)
    expect(increasing(ids(frames))).toBe(true)
    expect(frames[3]!.event).toMatchObject({ type: 'turnEnd', turnId: 'turn-crashed' })
    expect(frames.slice(4)).toEqual(next)
  })

  it('收尾本身抛错的轮当场发一个失败的终帧，连着的流与续播都收得到', async () => {
    const conversationId = await startConversation()
    await db.execute(
      sql`CREATE FUNCTION agent_message_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture message store unavailable'; END $$`,
    )
    await db.execute(
      sql`CREATE TRIGGER agent_message_fault BEFORE INSERT ON agent_messages FOR EACH ROW WHEN (NEW.role = 'assistant') EXECUTE FUNCTION agent_message_fault()`,
    )
    try {
      const frames = await completeTurn(conversationId, '你好', '好的')

      const ends = frames.filter((frame) => frame.event.type === 'turnEnd')
      expect(ends).toHaveLength(1)
      expect(frames.at(-1)!.event).toMatchObject({
        type: 'turnEnd',
        stopReason: 'failed',
        error: 'agent_run_failed',
      })
      await waitFor(async () => (await snapshot(conversationId)).activeTurn === null)
      expect(await conversationEvents(conversationId)).toEqual(frames)
    } finally {
      await db.execute(sql`DROP TRIGGER agent_message_fault ON agent_messages`)
      await db.execute(sql`DROP FUNCTION agent_message_fault()`)
    }
  })

  it('补写正占着租约时发消息，等它放手再起轮，而不是把补写当成一轮', async () => {
    const conversationId = await startConversation()
    await db.insert(schema.agent_executions).values({
      conversation_id: conversationId,
      turn_id: 'seal:fixture',
      instance: agentInstance,
      origin: 'http://self.test',
      state: 'running',
      heartbeat_at: Date.now(),
    })
    // 补写几次往返之后放手。
    const released = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
      await db
        .update(schema.agent_executions)
        .set({ state: 'completed' })
        .where(sql`${schema.agent_executions.conversation_id} = ${conversationId}`)
    })()

    const live = await startTurn(conversationId, '你好')
    await released
    expect(live.status).toBe(200)
    upstream.push('好的')
    upstream.finish()
    const frames = parseFrames(await live.text())

    expect(frames[0]!.event.type).toBe('turnStart')
    expect(frames.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  })

  it('还在跑的轮不补写', async () => {
    const conversationId = await startConversation()
    const live = startTurn(conversationId, '你好')
    upstream.push('好的')
    await readFrames(await live, 3)

    const state = await snapshot(conversationId)

    expect(state.activeTurn).not.toBeNull()
    expect(state.turns).toEqual([])
    upstream.finish()
    const frames = await conversationEvents(conversationId)
    expect(frames.filter((frame) => frame.event.type === 'turnEnd')).toHaveLength(1)
    expect(frames.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  })
})

describe('会话快照', () => {
  it('空闲时游标是最后一条事件，快照里就是全部内容', async () => {
    const conversationId = await startConversation()
    const frames = await completeTurn(conversationId, '你好', '好的')

    const state = await snapshot(conversationId)

    expect(state.cursor).toBe(frames.at(-1)!.id)
    expect(state.activeTurn).toBeNull()
    expect(state.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(state.turns).toEqual([
      expect.objectContaining({ turnId: state.messages[0]!.turnId, stopReason: 'completed' }),
    ])
  })

  it('有轮在跑时游标停在它的开始事件之前，另一台设备先取快照再接增量，看到的与直播一致', async () => {
    const conversationId = await startConversation()
    await completeTurn(conversationId, '你好', '好的')
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的，我先')
    const opening = await readFrames(live, 3)
    const turnStart = opening[0]!

    const other = await snapshot(conversationId)
    expect(other.activeTurn).toEqual({
      turnId: turnStart.event.type === 'turnStart' ? turnStart.event.turnId : '',
    })
    expect(other.cursor).toBe(turnStart.id! - 1)
    expect(other.messages.map((message) => message.content)).toContainEqual([
      { type: 'text', text: '画一只猫' },
    ])

    const following = app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/events`, {
        headers: withLastEventId(other.cursor),
      }),
    )
    upstream.push('画一只橘猫')
    upstream.finish()
    const followed = parseFrames(await (await following).text())

    // 另一台设备从游标接到的，正是这一轮的全部帧：起轮那条流看到的开头一帧不差。
    expect(followed.slice(0, opening.length)).toEqual(opening)
    expect(followed).toEqual(await turnEvents(conversationId, other.activeTurn!.turnId))
    expect(followed.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
  })
})
