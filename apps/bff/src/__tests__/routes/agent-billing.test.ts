import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
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
} from '../helpers/agentStubs'
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

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-billing-user'
let sessionToken = ''

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
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('对话轮的预扣', () => {
  it('起轮前按估算的输入与预留的输出预扣一次', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    const conversationId = await startConversation()

    const { frames } = await runTurn(conversationId, '把背景换成浅木色')

    expect(reservations).toHaveLength(1)
    expect(reservations[0]).toMatchObject({
      taskId: turnIdOf(frames),
      userId: USER_ID,
      model: 'fixture-agent-model',
      quantity: 1,
    })
    // 预留 2000 输出 token × 5 倍 = 固定 10；剩下的零头是这条短提示词的输入估算。
    expect(reservations[0]!.unitMultiplier).toBeGreaterThan(10)
    expect(reservations[0]!.unitMultiplier).toBeLessThan(10.5)
  })

  it('运营改了对话单价，下一轮就按新的输出倍数与预留预扣', async () => {
    setAgentFetchForTesting(recordingAgentFetch([], () => completionStream('好')))
    billing.pricing = { outputPriceRatio: 4, outputReserveTokens: 500 }
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')
    // 等这一轮结算落定再收尾，否则 afterAll 关库时还有在途写入。
    await waitFor(async () => settlements.length === 1)

    // 预留 500 输出 token × 4 倍 = 固定 2；剩下的零头是这条短提示词的输入估算。
    expect(reservations[0]!.unitMultiplier).toBeGreaterThan(2)
    expect(reservations[0]!.unitMultiplier).toBeLessThan(2.5)
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

    await runTurn(conversationId, '把背景换成浅木色')

    expect(await db.select().from(schema.tasks)).toEqual([])
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
  })

  it('失败的轮按失败结算，让占用整笔退回', async () => {
    setAgentFetchForTesting(async () => new Response('rate limited', { status: 429 }))
    const conversationId = await startConversation()

    await runTurn(conversationId, '把背景换成浅木色')

    expect(settlements).toHaveLength(1)
    expect(settlements[0]!.outcome).toBe('failed')
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
  })
})
