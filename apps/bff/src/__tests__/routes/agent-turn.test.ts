import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, AgentTurnEvent } from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completion,
  completionStream,
  parseFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_turn')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function startConversation(): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text }),
    }),
  )
  return { response, frames: parseFrames(await response.text()) }
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=${DEVICE}`,
    ),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

beforeEach(async () => {
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('POST /api/agent/conversations/:id/turns', () => {
  it('streams one turn and stores both messages', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      recordingAgentFetch(calls, () => completionStream('好的，', '我把背景换成浅木色')),
    )
    const conversationId = await startConversation()

    const { response, frames } = await runTurn(conversationId, '把背景换成浅木色')

    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(types(frames)).toEqual(['turnStart', 'textDelta', 'textDelta', 'turnEnd'])
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4])

    const start = frames[0]!.event
    const end = frames[3]!.event
    expect(start.type === 'turnStart' && start.turnId).toBeTruthy()
    expect(end.type === 'turnEnd' && end.turnId).toBe(
      start.type === 'turnStart' ? start.turnId : '',
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('http://gateway.test/v1/chat/completions')
    expect(calls[0]!.authorization).toBe('Bearer fixture-upstream-key')
    expect(calls[0]!.model).toBe('fixture-agent-model')

    const messages = await readMessages(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]!.content).toEqual([{ type: 'text', text: '把背景换成浅木色' }])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: '好的，我把背景换成浅木色' }])
    expect(messages[1]!.turnId).toBe(messages[0]!.turnId)
  })

  it('asks the gateway to report usage and passes what it reports to the turn end', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好')))
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    // 流式响应默认不带用量，`stream_options` 是 token 计费唯一的来源。
    expect(calls[0]!.stream_options).toEqual({ include_usage: true })
    const end = frames.at(-1)!.event
    expect(end.type === 'turnEnd' && end.usage).toEqual({ inputTokens: 12, outputTokens: 4 })
  })

  it('reports no usage when the gateway drops stream_options', async () => {
    setAgentFetchForTesting(
      recordingAgentFetch([], () => completion({ deltas: ['好'], usage: undefined })),
    )
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    const end = frames.at(-1)!.event
    expect(end.type).toBe('turnEnd')
    expect(end.type === 'turnEnd' && end.usage).toBeNull()
  })

  it('sends the stored history along with the new message', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好')))
    const conversationId = await startConversation()

    await runTurn(conversationId, '第一句')
    await runTurn(conversationId, '第二句')

    expect(calls).toHaveLength(2)
    expect(calls[1]!.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ])
    expect(await readMessages(conversationId)).toHaveLength(4)
  })

  it('names the conversation after the first message', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')

    const [row] = await db.select().from(schema.agent_conversations)
    expect(row!.title).toBe('把背景换成浅木色')
  })

  it('ends a failed turn with an error and stores no assistant message', async () => {
    setAgentFetchForTesting(async () => new Response('rate limited', { status: 429 }))
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    expect(types(frames)).toEqual(['turnStart', 'error'])
    expect(frames[1]!.event).toEqual({ type: 'error', error: 'agent_upstream_error' })

    const messages = await readMessages(conversationId)
    expect(messages.map((message) => message.role)).toEqual(['user'])
  })

  it('refuses a conversation that belongs to another device', async () => {
    const conversationId = await startConversation()

    const response = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-zzzzzzzz', text: '你好' }),
      }),
    )

    expect(response.status).toBe(404)
  })

  it('rejects an empty or oversized message and a short device id', async () => {
    const conversationId = await startConversation()
    const path = `/api/agent/conversations/${conversationId}/turns`

    expect((await post(path, { deviceId: DEVICE, text: '' })).status).toBe(400)
    expect((await post(path, { deviceId: DEVICE, text: 'x'.repeat(4001) })).status).toBe(400)
    expect((await post(path, { deviceId: 'short', text: '你好' })).status).toBe(400)
  })
})

describe('GET /api/agent/conversations/:id/messages', () => {
  it('answers 404 for a conversation of another device', async () => {
    const conversationId = await startConversation()

    const response = await app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${conversationId}/messages?deviceId=device-zzzzzzzz`,
      ),
    )

    expect(response.status).toBe(404)
  })
})
