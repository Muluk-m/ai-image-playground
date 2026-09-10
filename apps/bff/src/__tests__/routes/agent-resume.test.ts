import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentActiveTurnView, AgentMessageView } from '@image-playground/shared'
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
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_resume')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
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

async function drainFrames(response: Response): Promise<ReceivedFrame[]> {
  return parseFrames(await response.text())
}

function startTurn(conversationId: string, text: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, { deviceId: DEVICE, text })
}

function resume(conversationId: string, turnId: string, lastEventId?: number): Promise<Response> {
  const headers = new Headers()
  if (lastEventId !== undefined) headers.set('last-event-id', String(lastEventId))
  return app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/turns/${turnId}/events?deviceId=${DEVICE}`,
      { headers },
    ),
  )
}

async function readState(conversationId: string): Promise<{
  messages: AgentMessageView[]
  activeTurn: AgentActiveTurnView | null
}> {
  const response = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=${DEVICE}`,
    ),
  )
  return (await response.json()) as {
    messages: AgentMessageView[]
    activeTurn: AgentActiveTurnView | null
  }
}

let upstream: ControlledCompletion
let calls: AgentCall[]

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
  calls = []
  upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => upstream.responseFor(signal)))
})

/** 轮不再绑在消费者身上，用例留下的进行中的轮必须显式收掉，否则它会写向已关闭的库。 */
afterEach(async () => {
  for (const conversationId of opened.splice(0)) {
    const { activeTurn } = await readState(conversationId)
    if (!activeTurn) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${activeTurn.turnId}/abort`, {
      deviceId: DEVICE,
    })
    await waitFor(async () => (await readState(conversationId)).activeTurn === null)
  }
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('断线续播', () => {
  it('重连带上 Last-Event-ID，只补断点之后的事件', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '把背景换成浅木色')
    upstream.push('好的，')

    const seen = await readFrames(live, 3)
    expect(seen.map((frame) => frame.event.type)).toEqual([
      'turnStart',
      'assistantStart',
      'textDelta',
    ])
    expect(seen.map((frame) => frame.id)).toEqual([1, 2, 3])

    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    upstream.push('我把背景换成浅木色')
    upstream.finish()

    const rest = await drainFrames(await resumed)
    expect(rest.map((frame) => frame.id)).toEqual([4, 5])
    expect(rest.map((frame) => frame.event.type)).toEqual(['textDelta', 'turnEnd'])

    const { messages } = await readState(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '好的，我把背景换成浅木色' }])
  })

  it('轮跑完之后重连两次拿到同一段尾巴', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const first = await drainFrames(await resume(conversationId, turnId, 2))
    const second = await drainFrames(await resume(conversationId, turnId, 2))

    expect(first.map((frame) => frame.id)).toEqual([3, 4])
    expect(second).toEqual(first)
  })

  it('从头重连拿到整轮，刷新后的页面据此重建', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')

    await readFrames(live, 3)
    const { activeTurn } = await readState(conversationId)
    expect(activeTurn).not.toBeNull()

    const replayed = resume(conversationId, activeTurn!.turnId)
    upstream.finish()

    const frames = await drainFrames(await replayed)
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4])
    expect(await readState(conversationId).then((state) => state.activeTurn)).toBeNull()
  })

  it('不认识的轮回 404', async () => {
    const conversationId = await startConversation()

    expect((await resume(conversationId, 'turn-does-not-exist')).status).toBe(404)
  })
})

describe('中止', () => {
  it('中止进行中的轮，已经流出去的文字留在历史里', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的，我先')
    const seen = await readFrames(live, 3)
    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const aborted = await post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
      deviceId: DEVICE,
    })
    expect(aborted.status).toBe(200)

    const rest = await drainFrames(await resumed)
    const end = rest.at(-1)!.event
    expect(end).toMatchObject({ type: 'turnEnd', turnId, stopReason: 'aborted' })

    const { messages, activeTurn } = await readState(conversationId)
    expect(activeTurn).toBeNull()
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '好的，我先' }])
  })

  it('轮已经结束时中止回 404', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/abort`,
      { deviceId: DEVICE },
    )

    expect(response.status).toBe(404)
  })
})

describe('插话', () => {
  it('轮进行中追加一条用户消息，运行时接着它往下跑', async () => {
    const second = controlledCompletion()
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '画一只猫')
    upstream.push('好的')
    const seen = await readFrames(live, 3)
    const turnStart = seen[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const resumed = resume(conversationId, turnId, seen.at(-1)!.id)
    const interjected = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '改成狗' },
    )
    expect(interjected.status).toBe(200)

    setAgentFetchForTesting(recordingAgentFetch(calls, (signal) => second.responseFor(signal)))
    upstream.finish()
    await waitFor(() => calls.length === 2)
    second.push('好，改成狗')
    second.finish()

    const rest = await drainFrames(await resumed)
    expect(rest.map((frame) => frame.event.type)).toEqual([
      'interjection',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])
    expect(calls[1]!.messages.at(-1)).toMatchObject({ role: 'user' })

    const { messages } = await readState(conversationId)
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    expect(messages.map((message) => message.turnId)).toEqual([turnId, turnId, turnId, turnId])
  })

  it('轮已经结束时插话回 404', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    upstream.finish()
    const frames = await drainFrames(live)
    const turnStart = frames[0]!.event
    const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''

    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/interject`,
      { deviceId: DEVICE, text: '改成狗' },
    )

    expect(response.status).toBe(404)
  })
})

describe('并发', () => {
  it('同一个会话已经有轮在跑时不再起第二轮', async () => {
    const conversationId = await startConversation()
    const live = await startTurn(conversationId, '你好')
    upstream.push('好的')
    await readFrames(live, 3)

    const second = await startTurn(conversationId, '再来一句')

    expect(second.status).toBe(409)
    upstream.finish()
  })
})
