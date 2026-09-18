import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMessageQueuedBody,
  type AgentQueuedMessageView,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_queue_billing')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-billing-operator-config.json')

const billing = installRecordingTaskHooks()

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER_ID = 'agent-queue-billing-user'
let sessionToken = ''

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
        ...init.headers,
      },
    }),
  )
}

const post = (path: string, body: unknown) =>
  request(path, { method: 'POST', body: JSON.stringify(body) })

const opened: string[] = []

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const id = ((await response.json()) as { conversation: { id: string } }).conversation.id
  opened.push(id)
  return id
}

function send(conversationId: string, text: string, clientMessageId?: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
    ...(clientMessageId ? { clientMessageId } : {}),
  })
}

async function queued(response: Response): Promise<AgentMessageQueuedBody> {
  expect(response.status).toBe(202)
  return (await response.json()) as AgentMessageQueuedBody
}

async function queueList(conversationId: string): Promise<AgentQueuedMessageView[]> {
  const response = await request(`/api/agent/conversations/${conversationId}/queue`)
  return ((await response.json()) as { queue: AgentQueuedMessageView[] }).queue
}

async function activeTurn(conversationId: string): Promise<string | null> {
  const response = await request(`/api/agent/conversations/${conversationId}/messages`)
  return (
    ((await response.json()) as { activeTurn: { turnId: string } | null }).activeTurn?.turnId ??
    null
  )
}

let upstreams: ControlledCompletion[]
let calls: AgentCall[]

async function upstreamCall(index: number): Promise<ControlledCompletion> {
  await waitFor(() => upstreams.length > index, 3_000)
  return upstreams[index]!
}

beforeEach(async () => {
  billing.reset()
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER_ID,
    username: 'agent.queue.billing',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
  calls = []
  upstreams = []
  setAgentFetchForTesting(
    recordingAgentFetch(calls, (signal) => {
      const upstream = controlledCompletion()
      upstreams.push(upstream)
      return upstream.responseFor(signal)
    }),
  )
})

afterEach(async () => {
  await db.delete(schema.agent_inbox)
  for (const conversationId of opened.splice(0)) {
    const turnId = await activeTurn(conversationId)
    if (!turnId) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
      deviceId: DEVICE,
    })
    await waitFor(async () => (await activeTurn(conversationId)) === null, 3_000)
  }
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('排队消息轮到时开不了轮', () => {
  it('记下错误码、不再挡着后面的，撤掉才离开列表', async () => {
    const conversationId = await startConversation()
    const live = await send(conversationId, '先画一只猫')
    expect(live.status).toBe(200)
    const first = await upstreamCall(0)
    first.push('好的')
    await readFrames(live, 2)
    const second = await queued(await send(conversationId, '第二句'))
    const third = await queued(await send(conversationId, '第三句'))

    // 第一轮用光了余额：轮到排着的两句时预扣都被拒。
    billing.answer = { kind: 'insufficient_credits', required: 50, available: 3 }
    first.finish()

    await waitFor(
      async () => (await queueList(conversationId)).every((one) => one.failure !== undefined),
      3_000,
    )
    expect(await queueList(conversationId)).toEqual([
      { ...second.queued, failure: 'insufficient_credits' },
      { ...third.queued, failure: 'insufficient_credits' },
    ])
    expect(calls).toHaveLength(1)
    expect(await activeTurn(conversationId)).toBeNull()

    // 充值之后新发的一句当场开轮：没能开轮的两条不再挡在它前面，也不会被它连带撤掉。
    billing.answer = { kind: 'reserved', credits: 50 }
    const next = await send(conversationId, '第四句')
    expect(next.status).toBe(200)
    const fourth = await upstreamCall(1)
    expect(JSON.stringify(calls[1]!.messages)).toContain('第四句')
    expect(JSON.stringify(calls[1]!.messages)).not.toContain('第二句')
    fourth.finish()
    await next.text()
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([
      second.queued.id,
      third.queued.id,
    ])

    // 用户看过之后撤掉：它不会再被处理。
    const withdrawn = await post(
      `/api/agent/conversations/${conversationId}/queue/${second.queued.id}/withdraw`,
      { deviceId: DEVICE },
    )
    expect(await withdrawn.json()).toEqual({ result: 'cancelled' })
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([third.queued.id])
  })

  it('当场开不了轮的那一条被撤回，重发回报已撤回而不是已排队', async () => {
    const conversationId = await startConversation()
    billing.answer = { kind: 'insufficient_credits', required: 50, available: 3 }

    const refused = await send(conversationId, '画一只猫', 'client-refused')
    expect(refused.status).toBe(402)

    // 回程断了、客户端拿同一个 id 重发：服务端如实说这条已不在队里，客户端据此留住草稿。
    const retried = await queued(await send(conversationId, '画一只猫', 'client-refused'))
    expect(retried.state).toBe('cancelled')
    expect(retried.turnId).toBeUndefined()
    expect(await queueList(conversationId)).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
