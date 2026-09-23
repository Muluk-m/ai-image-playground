import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { resolve } from 'node:path'
import { Agent } from '@earendil-works/pi-agent-core'
import { resetTestDatabase } from '@image-playground/db/testing'
import { sql } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  type AgentCall,
  type ControlledCompletion,
  completion,
  completionStream,
  controlledCompletion,
  parseFrames,
  type ReceivedFrame,
  readFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('agent_billing_a288')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()
const { reservations, settlements } = billing

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-billing-user'
let sessionToken = ''
let storage: InMemoryObjectStore
const REFERENCE = { imageId: 'canvas-original', dataUrl: 'data:image/png;base64,aGk=' }

async function post(path: string, body: unknown, signedIn = true): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signedIn ? { cookie: `${USER_SESSION_COOKIE}=${sessionToken}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

async function startConversation(signedIn = true): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE }, signedIn)
  const json = (await response.json()) as { conversation: { id: string } }
  return json.conversation.id
}

async function runTurn(conversationId: string, text: string, signedIn = true) {
  const response = await post(
    `/api/agent/conversations/${conversationId}/turns`,
    { deviceId: DEVICE, text },
    signedIn,
  )
  const payload = await response.text()
  return { status: response.status, payload, frames: parseFrames(payload) }
}

/** 首帧不是 turnStart 就是这一轮压根没起来，别让断言用空串蒙混过去。 */
function turnIdOf(frames: readonly ReceivedFrame[]): string {
  const first = frames[0]?.event
  if (first?.type !== 'turnStart') throw new Error(`expected a turnStart frame, got ${first?.type}`)
  return first.turnId
}

beforeEach(async () => {
  billing.reset()
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.billing',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
})

afterEach(() => {
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('对话轮的预扣', () => {
  it('起轮前按估算的输入与预留的输出预扣一次', async () => {
    setAgentFetchForTesting(
      recordingAgentFetch([], () => {
        expect(reservations).toHaveLength(1)
        return completionStream('好')
      }),
    )
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    expect(reservations).toHaveLength(1)
    expect(reservations[0]).toMatchObject({
      taskId: turnIdOf(frames),
      userId: USER_ID,
      model: 'fixture-agent-model',
      quantity: 1,
    })
  })

  it('运营改了对话单价，下一轮就按新的输出倍数与预留预扣', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const baseline = await startConversation()
    await runTurn(baseline, '把背景换成浅木色')
    await waitFor(async () => settlements.length === 1)
    billing.pricing = { outputPriceRatio: 4, outputReserveTokens: 500 }
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')
    // 等这一轮结算落定再收尾，否则 afterAll 关库时还有在途写入。
    await waitFor(async () => settlements.length === 2)

    // 相同输入不受文案长度影响；输出预留从 2000×5 改为 500×4，每千 token 少预扣 8 单位。
    expect(reservations).toHaveLength(2)
    expect(reservations[0]!.unitMultiplier - reservations[1]!.unitMultiplier).toBeCloseTo(8, 6)
  })

  it('预扣之前先落一条对话任务，占用才挂得住，且不带用户原话', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({
      id: turnIdOf(frames),
      kind: 'chat',
      user_id: USER_ID,
      agent_conversation_id: conversationId,
      agent_turn_id: turnIdOf(frames),
    })
    // worker 只 claim queued；这一行永远捞不走。
    expect(task!.status).not.toBe('queued')
    expect(JSON.stringify(task!.request_payload)).not.toContain('把背景换成浅木色')
  })

  it('余额不足时连那条对话任务也不留', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.answer = { kind: 'insufficient_credits', required: 78, available: 12 }
    const conversationId = await startConversation()

    await post(`/api/agent/conversations/${conversationId}/turns`, {
      deviceId: DEVICE,
      text: '把背景换成浅木色',
      references: [REFERENCE],
    })

    expect(await db.select().from(schema.tasks)).toEqual([])
    expect(await storage.listPrefix(`agent/${conversationId}/`)).toEqual([])
  })

  it('余额不足在发送前拦住：不落消息、不调上游、不留轮', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('好')))
    billing.answer = { kind: 'insufficient_credits', required: 78, available: 12 }
    const conversationId = await startConversation()

    const { status, payload } = await runTurn(conversationId, '把背景换成浅木色')

    expect(status).toBe(402)
    expect(JSON.parse(payload)).toEqual({
      error: 'insufficient_credits',
      required: 78,
      available: 12,
    })
    expect(calls).toHaveLength(0)
    expect(settlements).toHaveLength(0)
    expect(await db.select().from(schema.agent_messages)).toHaveLength(0)
  })

  /**
   * 上一轮的参考图不再跟着下一轮重发：那批字节压根不读，所以读得出来读不出来都拖不垮纯文字轮。
   * 这一条从前钉的是反面——历史参考图读失败就整轮失败——那正是按需取图要治的病。
   */
  it('纯文字轮不重发历史参考图：不读对象存储，也不为它计图', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(recordingAgentFetch(calls, () => completionStream('已看到参考图')))
    const conversationId = await startConversation()
    const initial = await post(`/api/agent/conversations/${conversationId}/turns`, {
      deviceId: DEVICE,
      text: '[image 1] 看这张图',
      references: [REFERENCE],
    })
    await initial.text()
    // 只要第二轮去读一次归档的参考图就会炸；它一次都不读。
    storage.readFailuresRemaining = 1

    const { frames } = await runTurn(conversationId, '继续修改这张图')

    expect(frames.at(-1)!.event).toMatchObject({ type: 'turnEnd', stopReason: 'completed' })
    expect(storage.readFailuresRemaining).toBe(1)
    expect(calls).toHaveLength(2)
    // 第一轮附了一张图，第二轮一张都没有：预扣与计费看到的图数跟着实发走。
    expect(
      (await db.select().from(schema.agent_model_calls)).map((one) => one.input_image_count),
    ).toEqual([1, 0])
  })

  it('对话模型没有有效单价时拒绝起轮', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.answer = { kind: 'price_unavailable', model: 'fixture-agent-model' }
    const conversationId = await startConversation()

    const { status, payload } = await runTurn(conversationId, '把背景换成浅木色')

    expect(status).toBe(422)
    expect(JSON.parse(payload)).toEqual({
      error: 'model_price_unavailable',
      model: 'fixture-agent-model',
    })
  })

  it('计费部署里匿名设备起不了轮', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversationId = await startConversation(false)

    const { status } = await runTurn(conversationId, '把背景换成浅木色', false)

    expect(status).toBe(401)
    expect(reservations).toHaveLength(0)
  })
})

describe('对话轮的结算', () => {
  it('逐次保存工具循环用量，以原轮和调用身份结算', async () => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () => toolCallCompletion({ id: 'lookup-1', name: 'readLibrary', args: {} }),
          () => completionStream('没有匹配素材，可以上传一张'),
        ],
      ),
    )
    const conversationId = await startConversation()
    const { frames } = await runTurn(conversationId, '查找杯子素材')
    const turnId = turnIdOf(frames)

    expect(frames.at(-1)?.event).toMatchObject({
      type: 'turnEnd',
      usage: { inputTokens: 24, outputTokens: 8 },
    })
    expect(settlements[0]).toMatchObject({
      taskId: turnId,
      upstreamInvocationCount: 2,
      actualUsage: { tokens: { input: 24, output: 8 } },
    })
    const records = await db.execute(sql`
      SELECT * FROM agent_model_calls WHERE conversation_id = ${conversationId}
      ORDER BY started_at, id
    `)
    expect(records).toHaveLength(2)
    expect(new Set(records.map((row) => row.id)).size).toBe(2)
    for (const record of records) {
      expect(record).toMatchObject({
        conversation_id: conversationId,
        turn_id: turnId,
        user_id: USER_ID,
        device_id: DEVICE,
        purpose: 'conversation',
        status: 'completed',
        usage: { inputTokens: 12, outputTokens: 4 },
      })
    }
    expect(records[0]?.tool_calls).toEqual([{ id: 'lookup-1', name: 'readLibrary' }])
  })

  it('运行时淘汰消息且重复报告完成时，不漏计也不重复计费', async () => {
    const subscribe = Agent.prototype.subscribe
    let evicted = 0
    // 在第三方运行时边界注入重复完成和工作集淘汰，HTTP 入口与结算链路保持真实。
    const runtime = spyOn(Agent.prototype, 'subscribe').mockImplementation(function (
      this: Agent,
      listener,
    ) {
      return subscribe.call(this, async (event, signal) => {
        await listener(event, signal)
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          await listener(event, signal)
          this.state.messages = []
          evicted += 1
        }
      })
    })
    try {
      setAgentFetchForTesting(
        scriptedAgentFetch(
          [],
          [
            () => toolCallCompletion({ id: 'lookup-evict', name: 'readLibrary', args: {} }),
            () => completionStream('查完了'),
          ],
        ),
      )
      const conversationId = await startConversation()
      const { frames } = await runTurn(conversationId, '查一下素材')
      expect(evicted).toBe(2)
      expect(frames.at(-1)?.event).toMatchObject({
        type: 'turnEnd',
        usage: { inputTokens: 24, outputTokens: 8 },
      })
      expect(settlements).toHaveLength(1)
      expect(settlements[0]).toMatchObject({
        upstreamInvocationCount: 2,
        actualUsage: { tokens: { input: 24, output: 8 } },
      })
      expect(await db.select().from(schema.agent_model_calls)).toHaveLength(2)
    } finally {
      runtime.mockRestore()
    }
  })

  it('完成记录后账本不可查询时仍结束事件流并准确结算', async () => {
    await db.execute(sql`CREATE FUNCTION fixture_hide_usage_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        ALTER TABLE agent_model_calls RENAME TO fixture_model_calls;
        RETURN NEW;
      END $$`)
    await db.execute(sql`CREATE TRIGGER fixture_hide_usage_ledger
      AFTER INSERT ON agent_messages FOR EACH ROW WHEN (NEW.role = 'assistant')
      EXECUTE FUNCTION fixture_hide_usage_ledger()`)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
      const conversationId = await startConversation()
      const response = await post(`/api/agent/conversations/${conversationId}/turns`, {
        deviceId: DEVICE,
        text: '继续',
      })
      reader = response.body!.getReader()
      // 有意使收尾存储边界失效；取消悬挂的消费者，避免回归让测试永远等待。
      timeout = setTimeout(() => void reader?.cancel(), 1_000)
      let payload = ''
      const decoder = new TextDecoder()
      while (true) {
        const part = await reader.read()
        if (part.done) break
        payload += decoder.decode(part.value, { stream: true })
      }
      expect(parseFrames(payload).at(-1)?.event).toMatchObject({
        type: 'turnEnd',
        stopReason: 'completed',
        usage: { inputTokens: 12, outputTokens: 4 },
      })
      expect(settlements).toHaveLength(1)
      expect(settlements[0]).toMatchObject({
        outcome: 'completed',
        upstreamInvocationCount: 1,
        actualUsage: { tokens: { input: 12, output: 4 } },
      })
    } finally {
      clearTimeout(timeout)
      await reader?.cancel()
      await db.execute(sql`DROP TRIGGER fixture_hide_usage_ledger ON agent_messages`)
      await db.execute(sql`DROP FUNCTION fixture_hide_usage_ledger()`)
      await db.execute(sql`ALTER TABLE fixture_model_calls RENAME TO agent_model_calls`)
    }
  })

  it('按上游报的实际用量结算', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({
      taskId: turnIdOf(frames),
      outcome: 'completed',
      upstreamInvocationCount: 1,
      // 上游报 12 输入 / 4 输出：(12 + 4 × 5) / 1000。
      actualUsage: { quantity: 1, unitMultiplier: 0.032, tokens: { input: 12, output: 4 } },
    })
  })

  it('上游没报用量时不带实际用量，按预留全额结算', async () => {
    setAgentFetchForTesting(
      recordingAgentFetch([], () => completion({ deltas: ['好'], usage: undefined })),
    )
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')

    expect(settlements).toHaveLength(1)
    expect(settlements[0]!.outcome).toBe('completed')
    expect(settlements[0]!.actualUsage).toBeUndefined()
    expect((await db.select().from(schema.agent_model_calls))[0]).toMatchObject({
      status: 'completed',
      usage: null,
    })
  })

  it('失败的轮按失败结算，让占用整笔退回', async () => {
    setAgentFetchForTesting(async () => new Response('rate limited', { status: 429 }))
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')

    expect(settlements).toHaveLength(1)
    expect(settlements[0]!.outcome).toBe('failed')
    expect((await db.select().from(schema.agent_model_calls))[0]).toMatchObject({
      status: 'failed',
      usage: null,
    })
  })

  it('被中止的轮按取消结算，让占用整笔退回', async () => {
    const upstream: ControlledCompletion = controlledCompletion()
    setAgentFetchForTesting(recordingAgentFetch([], (signal) => upstream.responseFor(signal)))
    const conversationId = await startConversation()

    const live = await post(`/api/agent/conversations/${conversationId}/turns`, {
      deviceId: DEVICE,
      text: '画一只猫',
    })
    upstream.push('好的，我先')
    const turnId = turnIdOf(await readFrames(live, 3))

    const aborted = await post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
      deviceId: DEVICE,
    })
    expect(aborted.status).toBe(200)

    await waitFor(async () => settlements.length === 1)
    expect(settlements[0]).toMatchObject({ taskId: turnId, outcome: 'cancelled' })
    expect((await db.select().from(schema.agent_model_calls))[0]).toMatchObject({
      status: 'cancelled',
      usage: null,
    })
  })
})

it('settles reported cache hits at the configured rate without subtracting twice', async () => {
  billing.pricing = { outputPriceRatio: 5, outputReserveTokens: 1500, cachedInputPriceRatio: 0.1 }
  setAgentFetchForTesting(
    recordingAgentFetch([], () =>
      completion({
        deltas: ['收到'],
        usage: {
          prompt_tokens: 10000,
          completion_tokens: 1000,
          prompt_tokens_details: { cached_tokens: 8000 },
        },
      }),
    ),
  )
  const conversationId = await startConversation()
  const { frames } = await runTurn(conversationId, '简短回答')
  expect(frames.at(-1)!.event).toMatchObject({
    type: 'turnEnd',
    usage: { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000 },
  })
  expect(settlements[0]?.actualUsage?.unitMultiplier).toBeCloseTo(7.8)
  expect(settlements[0]?.actualUsage?.tokens).toEqual({
    input: 10000,
    cachedInput: 8000,
    output: 1000,
  })
  expect((await db.select().from(schema.agent_model_calls))[0]).toMatchObject({
    cache_read_tokens: 8000,
    usage: { inputTokens: 10000, cachedInputTokens: 8000, outputTokens: 1000 },
  })
})

it('does not treat partial multi-call usage as the complete turn for refunds', async () => {
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () => toolCallCompletion({ id: 'lookup-unknown', name: 'readLibrary', args: {} }),
        () => completion({ deltas: ['没有素材'] }),
      ],
    ),
  )
  const { frames } = await runTurn(await startConversation(), '查找素材')
  expect(frames.at(-1)?.event).toMatchObject({ type: 'turnEnd', usage: null })
  expect(settlements[0]).toMatchObject({ upstreamInvocationCount: 2 })
  expect(settlements[0]?.actualUsage).toBeUndefined()
})

it('counts a fully cached input even when uncached input and output are zero', async () => {
  billing.pricing = { outputPriceRatio: 5, outputReserveTokens: 1500, cachedInputPriceRatio: 0.1 }
  setAgentFetchForTesting(
    recordingAgentFetch([], () =>
      completion({
        deltas: ['收到'],
        usage: {
          prompt_tokens: 10000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 10000 },
        },
      }),
    ),
  )
  const { frames } = await runTurn(await startConversation(), '继续')
  expect(frames.at(-1)?.event).toMatchObject({
    type: 'turnEnd',
    usage: { inputTokens: 10000, cachedInputTokens: 10000, outputTokens: 0 },
  })
  expect(settlements[0]?.actualUsage?.unitMultiplier).toBe(1)
})
