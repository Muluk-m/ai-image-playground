import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMessageView,
  type AgentTurnEvent,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completion,
  completionStream,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

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
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const PIXEL = 'data:image/png;base64,aGk='

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

async function runTurn(
  conversationId: string,
  text: string,
  references?: readonly { imageId: string; dataUrl: string }[],
) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE, text, ...(references ? { references } : {}) }),
    }),
  )
  return { response, frames: parseFrames(await response.text()) }
}

/** 送上游的那一条用户消息拆成两半：真带着字节的图片块，和纯文字。 */
function sentBlocks(call: AgentCall): { readonly images: unknown[]; readonly text: string } {
  const content = call.messages.at(-1)?.content
  if (typeof content === 'string') return { images: [], text: content }
  if (!Array.isArray(content)) return { images: [], text: '' }
  const images: unknown[] = []
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) continue
    if (block.type === 'image_url') images.push(block)
    else if (block.type === 'text' && 'text' in block && typeof block.text === 'string')
      text += block.text
  }
  return { images, text }
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: { [DEVICE_ID_HEADER]: DEVICE },
    }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function types(frames: { event: AgentTurnEvent }[]): string[] {
  return frames.map((frame) => frame.event.type)
}

beforeEach(async () => {
  // 输入框附的参考图在起轮前先归档进对象存储，没有它带图的轮连模型都到不了。
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
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
    expect(types(frames)).toEqual([
      'turnStart',
      'assistantStart',
      'textDelta',
      'textDelta',
      'turnEnd',
    ])
    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5])

    const start = frames[0]!.event
    const end = frames.at(-1)!.event
    expect(start.type === 'turnStart' && start.turnId).toBeTruthy()
    expect(end).toMatchObject({
      type: 'turnEnd',
      turnId: start.type === 'turnStart' ? start.turnId : '',
      stopReason: 'completed',
    })

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

    expect(types(frames)).toEqual(['turnStart', 'turnEnd'])
    expect(frames[1]!.event).toMatchObject({
      type: 'turnEnd',
      stopReason: 'failed',
      error: 'agent_upstream_error',
    })

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

  /**
   * 上一轮附的图不再无条件跟着下一轮重发：纯文字轮一个图片块都不带，那批图只剩 id 与编号，
   * 模型真要看内容得自己调 viewImage。这条是「公鸡那一轮被上一轮的商务人像带偏」的回归。
   */
  it('stops resending last turn reference bytes on a text-only turn', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好的')))
    const conversationId = await startConversation()

    await runTurn(conversationId, '[image 1] 把这张修一下', [
      { imageId: 'canvas-portrait', dataUrl: PIXEL },
    ])
    await runTurn(conversationId, '再画一只公鸡')

    // 附了图的那一轮照旧把字节发出去。
    expect(sentBlocks(calls[0]!).images).toHaveLength(1)

    const second = sentBlocks(calls[1]!)
    expect(second.images).toEqual([])
    // 编号与 id 仍然可寻址，只是写明了内容不在这一份输入里。
    expect(second.text).toContain('[image 1] 图片 id canvas-portrait')
    expect(second.text).toContain('内容没有附在本轮输入里')
    expect(second.text).not.toContain('已附在本轮输入里')
  })

  /**
   * 按需取图的另一半：模型调 viewImage 之后，那张图的字节真的进了下一次上游请求。
   * 这一条钉的是与 pi 的约定——工具结果里的 image 块会随转录发出去；它一断，整个按需取图就是空的。
   */
  it('lets viewImage pull the bytes of a carried-over image into the model context', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => completionStream('好的'),
        () =>
          toolCallCompletion({ id: 'look-1', name: 'viewImage', args: { imageIds: ['image 1'] } }),
        () => completionStream('看到了，是一张人像'),
      ]),
    )
    const conversationId = await startConversation()

    await runTurn(conversationId, '[image 1] 把这张修一下', [
      { imageId: 'canvas-portrait', dataUrl: PIXEL },
    ])
    await runTurn(conversationId, '那张图里到底是什么？')

    // 起轮那一刻不带字节，工具跑完之后的那一次请求才带上。
    expect(sentBlocks(calls[1]!).images).toEqual([])
    expect(sentBlocks(calls[2]!).images).toHaveLength(1)
  })
})

describe('GET /api/agent/conversations/:id/messages', () => {
  it('answers 404 for a conversation of another device', async () => {
    const conversationId = await startConversation()

    const response = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
        headers: { [DEVICE_ID_HEADER]: 'device-zzzzzzzz' },
      }),
    )

    expect(response.status).toBe(404)
  })
})
