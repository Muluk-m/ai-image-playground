import { afterAll, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentSaveResponse,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import { type AgentCall, completionStream, recordingAgentFetch } from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

/**
 * 用户按下保存之后，智能体必须知道这件事——否则它会一直等一个永远不来的回音。
 * 这里钉住那条闭环：卡片就地改写成已保存，收件箱那条话当场开出一轮，模型在输入里读到它。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_saves_route')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

const card: AgentToolResultBlock = {
  type: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'saveAsset',
  status: 'succeeded',
  title: '存为素材：浴缸',
  saveCard: {
    kind: 'asset',
    status: 'pending',
    name: '浴缸',
    assetKind: 'product',
    background: 'transparent',
    views: [{ imageId: 'image-1', label: 'sheet', source: 'generated' }],
  },
}

let calls: AgentCall[]

function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [DEVICE_ID_HEADER]: DEVICE },
      body: JSON.stringify(body),
    }),
  )
}

/** 一段已经落下保存卡片的对话：卡片怎么来的不在这条路上，直接摆好它。 */
async function conversationWithCard(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await response.json()) as { conversation: { id: string } }
  await db.insert(schema.agent_messages).values({
    conversation_id: conversation.id,
    id: 'message-1',
    turn_id: 'turn-1',
    seq: 1,
    role: 'assistant',
    content: [card],
    created_at: Date.now(),
  })
  return conversation.id
}

function save(conversationId: string, name: string, recordId = 'asset-1'): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/saves`, {
    deviceId: DEVICE,
    toolCallId: 'call-1',
    kind: 'asset',
    recordId,
    name,
  })
}

beforeEach(() => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  calls = []
  // 每个用例开自己的会话，所以不清表：上一轮可能还在跑，清表会和它抢同一批行。
  setAgentFetchForTesting(
    recordingAgentFetch(calls, () => completionStream('存好了，挑一张素材我给你试一版。')),
  )
})

afterAll(async () => {
  setAgentFetchForTesting()
  await closeDb()
})

it('flips the card and wakes the agent with what the user saved', async () => {
  const conversationId = await conversationWithCard()

  const response = await save(conversationId, '主图浴缸')

  expect(response.status).toBe(200)
  const { message } = (await response.json()) as AgentSaveResponse
  const block = message.content[0]
  expect(block?.type === 'toolResult' && block.saveCard).toMatchObject({
    status: 'saved',
    recordId: 'asset-1',
    name: '主图浴缸',
  })
  // 保存本身就是下一轮的开端：模型在这一轮的输入里读到用户存了什么。
  await waitFor(() => calls.length > 0, 3_000)
  expect(JSON.stringify(calls[0]!.messages)).toContain('用户已保存素材「主图浴缸」')
})

it('answers 404 for a tool call this conversation does not have', async () => {
  const conversationId = await conversationWithCard()

  const response = await post(`/api/agent/conversations/${conversationId}/saves`, {
    deviceId: DEVICE,
    toolCallId: 'call-missing',
    kind: 'asset',
    recordId: 'asset-1',
    name: '浴缸',
  })

  expect(response.status).toBe(404)
})
