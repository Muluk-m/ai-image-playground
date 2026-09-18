import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentConversationSnapshot,
  type AgentMessageQueuedBody,
  type AgentQueuedMessageView,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  readFrames,
  recordingAgentFetch,
} from '../../helpers/agentStubs'
import { InMemoryObjectStore } from '../../helpers/inMemoryObjectStore'
import { waitFor } from '../../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_inbox_pickup')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../../agent-operator-config.json')

const { agentRoutes } = await import('../../../routes/agent')
const { setAgentFetchForTesting } = await import('../../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../../db/client')
const { enqueueAgentUserMessage } = await import('../../../lib/agent/inbox')
const { appendAgentMessage } = await import('../../../lib/agent/conversations')
const { pickUpStrandedInboxes, strandedInboxConversations } = await import(
  '../../../lib/agent/inbox-pickup'
)
const { bffDrain } = await import('../../../lib/drain')

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', [DEVICE_ID_HEADER]: DEVICE },
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

function send(conversationId: string, text: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, { deviceId: DEVICE, text })
}

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  return (await (
    await request(`/api/agent/conversations/${conversationId}/messages`)
  ).json()) as AgentConversationSnapshot
}

async function queueList(conversationId: string): Promise<AgentQueuedMessageView[]> {
  const response = await request(`/api/agent/conversations/${conversationId}/queue`)
  return ((await response.json()) as { queue: AgentQueuedMessageView[] }).queue
}

/** 收尾实例没能接着处理、留在收件箱里的一条：直接写进去，就像旧实例收下它之后下线了。 */
async function strand(conversationId: string, text: string): Promise<string> {
  const result = await enqueueAgentUserMessage(conversationId, {
    clientMessageId: crypto.randomUUID(),
    text,
    deviceId: DEVICE,
    references: [],
  })
  if (result.kind !== 'queued') throw new Error(`expected a queued message, got ${result.kind}`)
  return result.entry.view.id
}

/** 一段已经结束的对话：它的执行租约已经放手。 */
async function idleConversation(): Promise<string> {
  const conversationId = await startConversation()
  const response = await send(conversationId, '先画一只猫')
  const upstream = await upstreamCall(0)
  upstream.push('好的')
  upstream.finish()
  await response.text()
  await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
  return conversationId
}

let upstreams: ControlledCompletion[]
let calls: AgentCall[]

async function upstreamCall(index: number): Promise<ControlledCompletion> {
  await waitFor(() => upstreams.length > index, 3_000)
  return upstreams[index]!
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
  await db.delete(schema.agent_executions)
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
    const { activeTurn } = await snapshot(conversationId)
    if (!activeTurn) continue
    await post(`/api/agent/conversations/${conversationId}/turns/${activeTurn.turnId}/abort`, {
      deviceId: DEVICE,
    })
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
  }
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('接手没人处理的排队消息', () => {
  it('巡查找到没有执行租约的会话，按顺序接着开轮', async () => {
    const conversationId = await idleConversation()
    const first = await strand(conversationId, '旧实例收下的第二句')
    const second = await strand(conversationId, '旧实例收下的第三句')

    expect(await strandedInboxConversations()).toEqual([conversationId])
    expect(await pickUpStrandedInboxes()).toBe(1)

    const call = await upstreamCall(1)
    expect(JSON.stringify(calls[1]!.messages)).toContain('旧实例收下的第二句')
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([second])
    // 正在跑的会话不算没人处理：再巡一次不会抢着开第二轮。
    expect(await strandedInboxConversations()).toEqual([])
    call.finish()

    // 接手的那一轮收尾后照常接着取下一条。
    const next = await upstreamCall(2)
    expect(JSON.stringify(calls[2]!.messages)).toContain('旧实例收下的第三句')
    next.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    const users = (await snapshot(conversationId)).messages.filter((one) => one.role === 'user')
    expect(users.map((one) => one.id).slice(1)).toEqual([first, second])
  })

  it('别的实例还握着活着的租约时不去抢', async () => {
    const conversationId = await idleConversation()
    await strand(conversationId, '排着的一句')
    await db
      .update(schema.agent_executions)
      .set({ state: 'running', instance: 'other-host:alive', heartbeat_at: Date.now() })

    expect(await strandedInboxConversations()).toEqual([])
    expect(await pickUpStrandedInboxes()).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('读快照时发现没人处理就当场接手，客户端再看一次就挂得上', async () => {
    const conversationId = await idleConversation()
    await strand(conversationId, '刷新后才被接手的一句')

    await snapshot(conversationId)

    await upstreamCall(1)
    expect(JSON.stringify(calls[1]!.messages)).toContain('刷新后才被接手的一句')
    await waitFor(async () => (await snapshot(conversationId)).activeTurn !== null, 3_000)
  })

  it('新发的一句排在没人处理的那条后面，202 报的是它此刻的状态与在跑的那一轮', async () => {
    const conversationId = await idleConversation()
    const stranded = await strand(conversationId, '先排着的一句')

    const response = await send(conversationId, '后来的一句')

    expect(response.status).toBe(202)
    const body = (await response.json()) as AgentMessageQueuedBody
    await upstreamCall(1)
    expect(JSON.stringify(calls[1]!.messages)).toContain('先排着的一句')
    expect(body.state).toBe('pending')
    expect(body.turnId).toBe((await snapshot(conversationId)).activeTurn!.turnId)
    const users = (await snapshot(conversationId)).messages.filter((one) => one.role === 'user')
    expect(users.at(-1)!.id).toBe(stranded)
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([body.queued.id])
  })

  it('在等澄清答复的会话不占巡查的名额，真没人处理的会话照样被接手', async () => {
    // 比一批的上限多：它们要是被选进来，就会把没人处理的那一个挤出这一批。
    for (let index = 0; index < 51; index += 1) {
      const held = await startConversation()
      await strand(held, `问澄清之前排着的第 ${index} 句`)
      await appendAgentMessage(db, {
        conversationId: held,
        turnId: `turn-${index}`,
        role: 'assistant',
        content: [{ type: 'clarification', question: '猫要什么颜色？', options: ['黑色', '白色'] }],
      })
    }
    const stranded = await startConversation()
    await strand(stranded, '真没人处理的一句')

    expect(await strandedInboxConversations()).toEqual([stranded])
  })

  // 放在最后：下线开始后本进程不再接新活。
  it('本实例下线时收尾不开下一轮，排着的消息原样待处理、留给新版本', async () => {
    const conversationId = await startConversation()
    const live = await send(conversationId, '先画一只猫')
    const first = await upstreamCall(0)
    first.push('好的')
    await readFrames(live, 2)
    const response = await send(conversationId, '下线前排进来的一句')
    const queued = (await response.json()) as AgentMessageQueuedBody

    bffDrain.begin()
    first.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    await Bun.sleep(100)

    // 没有记成开不了轮，也没被处理：新版本的巡查会接手它。
    expect(await queueList(conversationId)).toEqual([queued.queued])
    expect(calls).toHaveLength(1)
    expect(await strandedInboxConversations()).toEqual([conversationId])
    // 正在下线的实例自己不接。
    expect(await pickUpStrandedInboxes()).toBe(0)
  })
})
