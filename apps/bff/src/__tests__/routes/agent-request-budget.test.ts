import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_USER_MESSAGE_MAX_CHARS,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

/**
 * 出站预算的行为面。预算算式本身钉在 `lib/agent/request-budget.test.ts`：那一格从这里很难
 * 稳定命中。这里只断言用户与运营看得见的三件事——历史再长出站也不跟着长、摘要失败不回退成
 * 发完整历史、装不下就根本不发。
 */

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_request_budget')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
// 小窗口：真实部署的窗口装得下任何测试历史，闸门永远摸不到。
process.env.AGENT_CHAT_CONTEXT_WINDOW = '12000'
process.env.AGENT_CHAT_MAX_TOKENS = '1000'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../agent-compaction-operator-config.json',
)

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../lib/chatCompletion'
)
// 这几条测试故意让上游 502/503：重试真退避要花掉一秒半墙钟，换不来任何确定性。
setChatRetryBackoffForTesting(0)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { appendAgentMessage } = await import('../../lib/agent/conversations')
const { close: closeDb, db, schema } = await import('../../db/client')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

function post(path: string, body: unknown): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  return ((await response.json()) as { conversation: { id: string } }).conversation.id
}

async function runTurn(conversationId: string, text: string) {
  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
  })
  return parseFrames(await response.text())
}

/** 一段谁也压不动的历史：每条都是一大段中文，落库之后每一轮都会被回放。 */
async function seedHistory(conversationId: string, turns: number): Promise<void> {
  for (let at = 0; at < turns; at += 1) {
    await appendAgentMessage(db, {
      conversationId,
      turnId: `seed-${at}`,
      role: at % 2 === 0 ? 'user' : 'assistant',
      content: [
        { type: 'text', text: `第 ${at} 段历史。${'把这只橘猫画得更亮一点。'.repeat(40)}` },
      ],
    })
  }
}

/** 这一次真正发出去的那一份有多大。量的是记录到的请求体，不是任何内部状态。 */
function sentChars(call: AgentCall): number {
  return JSON.stringify({ messages: call.messages, tools: call.tools }).length
}

async function turnWithHistory(turns: number): Promise<AgentCall> {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('好的')]))
  const conversationId = await startConversation()
  await seedHistory(conversationId, turns)
  await runTurn(conversationId, '继续')
  expect(calls).toHaveLength(1)
  return calls[0]!
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  setAgentFetchForTesting()
  setChatFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

// 「历史再长也不先全量读取后再压缩」的外部表现：历史翻两番，出站那一份不跟着翻。
it('历史长四倍，真正发出去的那一份不跟着长', async () => {
  setChatFetchForTesting(async () => new Response('nope', { status: 502 }))
  const short = sentChars(await turnWithHistory(20))
  const long = sentChars(await turnWithHistory(80))

  expect(long).toBeLessThan(short * 1.5)
})

it('摘要失败也不回退发完整历史', async () => {
  // 摘要走的是另一条上游（chatCompletion）：让它一直 502，压缩就拿不出新摘要。
  setChatFetchForTesting(async () => new Response('nope', { status: 502 }))

  const call = await turnWithHistory(40)

  // 完整历史是 40 条加本轮那一句；发出去的远少于它。
  expect(call.messages.length).toBeLessThan(20)
})
it('本轮必要内容自己就装不下时不发请求，轮以「内容太长」收场', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('不该走到这里')))
  const conversationId = await startConversation()
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } })
    .png()
    .toBuffer()
  // 一句顶格长的话加满能内联的那几张参考图。这些都是本轮的必要内容，裁历史裁不掉它们。
  const references = Array.from({ length: AGENT_TURN_MAX_INLINE_REFERENCES }, (_, at) => ({
    imageId: `img-${at}`,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }))

  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text: '把这只橘猫画得更亮一点。'.repeat(AGENT_USER_MESSAGE_MAX_CHARS / 12),
    references,
  })
  const frames = parseFrames(await response.text())

  expect(calls).toHaveLength(0)
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({
    stopReason: 'failed',
    error: 'agent_context_overflow',
  })
})
