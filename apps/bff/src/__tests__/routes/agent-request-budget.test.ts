import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  AGENT_USER_MESSAGE_MAX_CHARS,
} from '@image-playground/shared'
import { eq, sql } from 'drizzle-orm'
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

const { config } = await import('../../config')
const operator = config.operator

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
  setChatFetchForTesting(async () => new Response('no chat upstream', { status: 400 }))
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
})

afterEach(() => {
  config.operator = operator
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

it('最终请求超过字节限制时，本地拒绝穿过 SDK 包装且不派发', async () => {
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': 1 },
  }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('不该派发')))
  const conversationId = await startConversation()
  const frames = await runTurn(conversationId, '比较猫咪🐈的颜色')

  expect(calls).toHaveLength(0)
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({
    stopReason: 'failed',
    error: 'agent_request_budget_exceeded',
    usage: { inputTokens: 0, outputTokens: 0 },
  })
  const [call] = await db
    .select()
    .from(schema.agent_model_calls)
    .where(eq(schema.agent_model_calls.conversation_id, conversationId))
  expect(call).toMatchObject({
    http_dispatch_count: 0,
    local_rejection: 'body_too_large',
    usage: { inputTokens: 0, outputTokens: 0 },
    status: 'failed',
  })
  expect(call?.request_bytes).toBeGreaterThan(1)
})

it('摘要出站超字节限制时，既不派发摘要也不回退派发主模型', async () => {
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': 1 },
  }
  let summaries = 0
  setChatFetchForTesting(async () => {
    summaries += 1
    return new Response('nope', { status: 502 })
  })
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('不该派发')))
  const conversationId = await startConversation()
  await seedHistory(conversationId, 40)
  const frames = await runTurn(conversationId, '继续比较猫咪🐈')

  expect(summaries).toBe(0)
  expect(calls).toHaveLength(0)
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({
    stopReason: 'failed',
    error: 'agent_request_budget_exceeded',
    usage: { inputTokens: 0, outputTokens: 0 },
  })
})

it('按实际 UTF-8 body 而非字符数计量中文、emoji 与 base64，边界内完整发送', async () => {
  const bodies: string[] = []
  setAgentFetchForTesting(async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('expected serialized SDK body')
    bodies.push(init.body)
    return completionStream('已看到图片')
  })
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } })
    .png()
    .toBuffer()
  const text = '比较猫咪🐈与蓝色天空🌌'
  const references = [
    { imageId: 'original', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
  ]
  const send = async () => {
    const id = await startConversation()
    const response = await post(`/api/agent/conversations/${id}/turns`, {
      deviceId: DEVICE,
      text,
      references,
    })
    return eventsOfType(parseFrames(await response.text()), 'turnEnd')[0]
  }
  expect(await send()).toMatchObject({ stopReason: 'completed' })
  const body = bodies[0]!
  expect(body).toContain(text)
  expect(body).toContain('data:image/')
  const bytes = new TextEncoder().encode(body).byteLength
  expect(bytes).toBeGreaterThan(body.length)
  const limit = (maxBytes: number) => {
    config.operator = {
      ...operator,
      quotas: { ...operator.quotas, 'agent:request-max-bytes': maxBytes },
    }
  }

  limit(body.length)
  expect(await send()).toMatchObject({ error: 'agent_request_budget_exceeded' })
  expect(bodies).toHaveLength(1)
  limit(bytes)
  expect(await send()).toMatchObject({ stopReason: 'completed' })
  expect(bodies).toHaveLength(2)
  expect(new TextEncoder().encode(bodies[1]!).byteLength).toBe(bytes)
  limit(bytes - 1)
  expect(await send()).toMatchObject({ error: 'agent_request_budget_exceeded' })
  expect(bodies).toHaveLength(2)
})

it('并发会话的本地拒绝不会污染已经派发的另一逻辑调用', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let dispatches = 0
  setAgentFetchForTesting(async () => {
    dispatches += 1
    entered.resolve()
    await release.promise
    return completionStream('成功调用')
  })
  const first = await startConversation()
  const second = await startConversation()
  const pending = runTurn(first, '正常请求')
  await entered.promise
  try {
    config.operator = { ...operator, quotas: { ...operator.quotas, 'agent:request-max-bytes': 1 } }
    const rejected = await runTurn(second, '超限请求')
    expect(eventsOfType(rejected, 'turnEnd')[0]).toMatchObject({
      error: 'agent_request_budget_exceeded',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  } finally {
    release.resolve()
  }
  const completed = eventsOfType(await pending, 'turnEnd')[0]
  expect(completed).toMatchObject({
    stopReason: 'completed',
    usage: { inputTokens: 12, outputTokens: 4 },
  })
  expect(completed?.error).toBeUndefined()
  expect(dispatches).toBe(1)
})

it('主模型真实 502 只派发一次，保留上游未知用量', async () => {
  let dispatches = 0
  setAgentFetchForTesting(async () => {
    dispatches += 1
    return new Response('upstream unavailable', { status: 502 })
  })
  const frames = await runTurn(await startConversation(), '请继续')
  expect(dispatches).toBe(1)
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({
    error: 'agent_upstream_error',
    usage: null,
  })
})

it('cancellation during dispatch recording keeps zero actual calls and zero settlement', async () => {
  const { createAgentUsageLedger } = await import('../../lib/agent/usage-ledger')
  const { guardedAgentFetch } = await import('../../lib/agent/outbound-budget')
  const { withIdleTimeout } = await import('../../lib/agent/stream-idle')
  const conversationId = await startConversation()
  const ledger = createAgentUsageLedger({
    conversationId,
    turnId: 'cancel-before-fetch',
    userId: null,
    deviceId: DEVICE,
  })
  const callId = await ledger.begin('conversation', 'fixture-agent-model')
  const controller = new AbortController()
  let calls = 0
  const fetch = guardedAgentFetch(
    withIdleTimeout(async () => {
      calls++
      return new Response()
    }, 1000),
    {
      onDispatch: async (bytes) => {
        await ledger.dispatched(callId, bytes)
        controller.abort()
      },
      onCancelledBeforeDispatch: () => ledger.cancelledBeforeDispatch(callId),
    },
  )
  await expect(
    fetch('http://gateway.test', { body: '{}', signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(calls).toBe(0)
  expect(ledger.settlement()).toEqual({
    upstreamInvocationCount: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  })
  const [call] = await db
    .select()
    .from(schema.agent_model_calls)
    .where(eq(schema.agent_model_calls.id, callId))
  expect(call).toMatchObject({
    http_dispatch_count: 0,
    status: 'cancelled',
    usage: { inputTokens: 0, outputTokens: 0 },
  })
})

it('aborting a real turn while dispatch recording is blocked never sends or charges the model request', async () => {
  const { waitFor } = await import('../helpers/upstreamStubs')
  const conversationId = await startConversation()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('must not send')))
  let unlock!: () => void
  let locked!: () => void
  const barrier = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const acquired = new Promise<void>((resolve) => {
    locked = resolve
  })
  const holding = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(9731142)`)
    locked()
    await barrier
  })
  await acquired
  await db.execute(
    sql`CREATE FUNCTION hold_model_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.http_dispatch_count = 1 AND OLD.http_dispatch_count = 0 THEN PERFORM pg_advisory_xact_lock(9731142); END IF; RETURN NEW; END $$`,
  )
  await db.execute(
    sql`CREATE TRIGGER hold_model_dispatch BEFORE UPDATE ON agent_model_calls FOR EACH ROW EXECUTE FUNCTION hold_model_dispatch()`,
  )
  const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text: 'cancel this request',
  })
  const frames = response.text().then(parseFrames)
  try {
    await waitFor(
      async () =>
        (
          await db.execute(
            sql`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 9731142::oid AND NOT granted`,
          )
        ).length > 0,
    )
    const [recorded] = await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.conversation_id, conversationId))
    expect(recorded).toBeDefined()
    expect(
      (
        await post(`/api/agent/conversations/${conversationId}/turns/${recorded!.turn_id}/abort`, {
          deviceId: DEVICE,
        })
      ).status,
    ).toBe(200)
    unlock()
    await holding
    const end = eventsOfType(await frames, 'turnEnd')[0]
    expect(end).toMatchObject({ stopReason: 'aborted', usage: { inputTokens: 0, outputTokens: 0 } })
    expect(calls).toHaveLength(0)
    const [settled] = await db
      .select()
      .from(schema.agent_model_calls)
      .where(eq(schema.agent_model_calls.id, recorded!.id))
    expect(settled).toMatchObject({
      http_dispatch_count: 0,
      status: 'cancelled',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
  } finally {
    unlock()
    await holding
    await frames
    await db.execute(sql`DROP TRIGGER hold_model_dispatch ON agent_model_calls`)
    await db.execute(sql`DROP FUNCTION hold_model_dispatch()`)
  }
})
