import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  AGENT_QUEUE_MAX_PENDING,
  type AgentConversationSnapshot,
  type AgentMessageQueuedBody,
  type AgentQueuedMessageView,
  type AgentQueueWithdrawResult,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  type ControlledCompletion,
  controlledCompletion,
  parseFrames,
  type ReceivedFrame,
  readFrames,
  recordingAgentFetch,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { waitFor } from '../helpers/upstreamStubs'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_queue')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')
const { appendAgentMessage } = await import('../../lib/agent/conversations')

await silenceChatUpstream()

const app = new Elysia().use(agentRoutes)

/** 写对象存储时停在门口，直到测试放行：插话归档参考图的那几秒由测试掌控。 */
class GatedObjectStore extends InMemoryObjectStore {
  private gate: Promise<void> | null = null
  private release: () => void = () => {}

  hold(): void {
    this.gate = new Promise((resolve) => {
      this.release = resolve
    })
  }

  letThrough(): void {
    this.gate = null
    this.release()
  }

  override async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.events.push(`waiting:${key}`)
    if (this.gate) await this.gate
    return super.write(key, bytes, contentType)
  }
}

async function referenceImage(imageId: string) {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 4, background: '#ffffff' },
  })
    .png()
    .toBuffer()
  return { imageId, dataUrl: `data:image/png;base64,${png.toString('base64')}` }
}

type Reference = Awaited<ReturnType<typeof referenceImage>>

function sendWithReference(
  conversationId: string,
  text: string,
  reference: Reference,
): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns`, {
    deviceId: DEVICE,
    text,
    references: [reference],
  })
}

function abortTurn(conversationId: string, turnId: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/turns/${turnId}/abort`, {
    deviceId: DEVICE,
  })
}

function interjectQueued(conversationId: string, queueId: string): Promise<Response> {
  return post(`/api/agent/conversations/${conversationId}/queue/${queueId}/interject`, {
    deviceId: DEVICE,
  })
}

/** 智能体在这一轮里问了一个澄清：直接落一条澄清消息，与它在轮中落库的形状一致。 */
async function askClarification(conversationId: string, turnId: string): Promise<void> {
  await appendAgentMessage(db, {
    conversationId,
    turnId,
    role: 'assistant',
    content: [{ type: 'clarification', question: '猫要什么颜色？', options: ['黑色', '白色'] }],
  })
}
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

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, { headers: { [DEVICE_ID_HEADER]: DEVICE, ...headers } }),
  )
}

const opened: string[] = []

async function startConversation(): Promise<string> {
  const response = await post('/api/agent/conversations', { deviceId: DEVICE })
  const json = (await response.json()) as { conversation: { id: string } }
  opened.push(json.conversation.id)
  return json.conversation.id
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

async function snapshot(conversationId: string): Promise<AgentConversationSnapshot> {
  return (await (
    await get(`/api/agent/conversations/${conversationId}/messages`)
  ).json()) as AgentConversationSnapshot
}

async function queueList(conversationId: string): Promise<AgentQueuedMessageView[]> {
  const response = await get(`/api/agent/conversations/${conversationId}/queue`)
  expect(response.status).toBe(200)
  return ((await response.json()) as { queue: AgentQueuedMessageView[] }).queue
}

async function withdraw(
  conversationId: string,
  queueId: string,
): Promise<{ status: number; result?: AgentQueueWithdrawResult }> {
  const response = await post(
    `/api/agent/conversations/${conversationId}/queue/${queueId}/withdraw`,
    { deviceId: DEVICE },
  )
  const json = (await response.json()) as { result?: AgentQueueWithdrawResult }
  return { status: response.status, ...json }
}

/** 最后一条用户消息的正文：看上游这一次是在处理哪句话。 */
function lastUserText(call: AgentCall): string {
  const users = call.messages.filter((message) => message.role === 'user')
  return JSON.stringify(users.at(-1)?.content)
}

/** 会话从头到现在的全部事件，另一个连着的设备看到的就是这一份。 */
async function conversationEvents(conversationId: string): Promise<ReceivedFrame[]> {
  const response = await get(`/api/agent/conversations/${conversationId}/events`)
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  // 在跑的轮会一直流下去；读到眼下已经发出的就撒手。
  const deadline = Date.now() + 200
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(50).then(() => null)])
    if (!next) break
    if (next.done) break
    buffered += decoder.decode(next.value, { stream: true })
  }
  // 不等取消落定：服务端那头正挂在等下一条事件上，要等到这一轮再有动静才会收。
  void reader.cancel()
  return parseFrames(buffered)
}

/** 每次上游调用一条由测试驱动的流：第 N 次调用就是第 N 轮的回复。 */
let upstreams: ControlledCompletion[]
let calls: AgentCall[]

async function upstreamCall(index: number): Promise<ControlledCompletion> {
  await waitFor(() => upstreams.length > index, 3_000)
  return upstreams[index]!
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
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

/** 排着的先清掉，再收掉在跑的轮：否则收尾时队里的下一条会接着开轮，写向已关闭的库。 */
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

/** 起第一轮并让它停在说话中途：会话此刻是忙的。 */
async function busyConversation() {
  const conversationId = await startConversation()
  const live = await send(conversationId, '先画一只猫')
  expect(live.status).toBe(200)
  const first = await upstreamCall(0)
  first.push('好的，')
  const opening = await readFrames(live, 3)
  const turnStart = opening[0]!.event
  const turnId = turnStart.type === 'turnStart' ? turnStart.turnId : ''
  return { conversationId, turnId, first }
}

describe('排队消息', () => {
  it('会话忙时发送返回已排队，出现在排队列表、快照与会话事件里', async () => {
    const { conversationId, turnId } = await busyConversation()

    const body = await queued(await send(conversationId, '再加一只狗', 'client-1'))

    expect(body.state).toBe('pending')
    expect(body.turnId).toBe(turnId)
    expect(body.queued).toMatchObject({
      clientMessageId: 'client-1',
      text: '再加一只狗',
      referenceCount: 0,
    })
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([body.queued.id])
    // 刷新后的页面读快照；另一台设备接会话级事件——两边看到的是同一份。
    expect((await snapshot(conversationId)).queue?.map((one) => one.id)).toEqual([body.queued.id])
    const events = await conversationEvents(conversationId)
    expect(events.map((frame) => frame.event)).toContainEqual({
      type: 'messageQueued',
      message: body.queued,
    })
    // 排着的话还没进对话：上游只见过第一句。
    expect(calls).toHaveLength(1)
  })

  it('当前回复结束后按顺序处理排队消息，每轮取一条', async () => {
    const { conversationId, turnId, first } = await busyConversation()
    const second = await queued(await send(conversationId, '第二句'))
    const third = await queued(await send(conversationId, '第三句'))

    first.push('猫画好了')
    first.finish()

    // 第一轮收尾，第二句自己开了一轮；第三句还排着。
    const secondCall = await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('第二句')
    expect(lastUserText(calls[1]!)).not.toContain('第三句')
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([third.queued.id])
    const running = await snapshot(conversationId)
    expect(running.activeTurn?.turnId).toBeDefined()
    expect(running.activeTurn?.turnId).not.toBe(turnId)
    // 取走那一刻就是这一轮的开头：消费事件紧跟在 turnStart 之后。
    const events = await conversationEvents(conversationId)
    const types = events.map((frame) => frame.event.type)
    const consumed = events.find((frame) => frame.event.type === 'queuedMessageConsumed')
    expect(consumed?.event).toEqual({
      type: 'queuedMessageConsumed',
      queueId: second.queued.id,
      turnId: running.activeTurn!.turnId,
    })
    expect(types[types.indexOf('queuedMessageConsumed') - 1]).toBe('turnStart')

    secondCall.push('狗也画好了')
    secondCall.finish()
    const thirdCall = await upstreamCall(2)
    expect(lastUserText(calls[2]!)).toContain('第三句')
    thirdCall.push('都好了')
    thirdCall.finish()

    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    const done = await snapshot(conversationId)
    expect(done.queue).toEqual([])
    const texts = done.messages.map((message) => [
      message.role,
      JSON.stringify(message.content).match(/"text":"([^"]*)"/)?.[1],
    ])
    expect(texts).toEqual([
      ['user', '先画一只猫'],
      ['assistant', '好的，猫画好了'],
      ['user', '第二句'],
      ['assistant', '狗也画好了'],
      ['user', '第三句'],
      ['assistant', '都好了'],
    ])
    // 每条排队消息落成它自己那一轮的用户消息，id 沿用收件箱的 id。
    const userMessages = done.messages.filter((message) => message.role === 'user')
    expect(userMessages[1]!.id).toBe(second.queued.id)
    expect(userMessages[2]!.id).toBe(third.queued.id)
    expect(new Set(done.messages.map((message) => message.turnId)).size).toBe(3)
  })

  it('撤回返回三态之一，撤回的消息不会被处理', async () => {
    const { conversationId, first } = await busyConversation()
    const kept = await queued(await send(conversationId, '留着这句'))
    const dropped = await queued(await send(conversationId, '撤回这句'))

    expect(await withdraw(conversationId, dropped.queued.id)).toEqual({
      status: 200,
      result: 'cancelled',
    })
    // 再撤一次仍是同一个结局；没有的那条就是没有。
    expect((await withdraw(conversationId, dropped.queued.id)).result).toBe('cancelled')
    expect((await withdraw(conversationId, 'no-such-message')).result).toBe('not_found')
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([kept.queued.id])
    const events = await conversationEvents(conversationId)
    expect(events.map((frame) => frame.event)).toContainEqual({
      type: 'queuedMessageWithdrawn',
      queueId: dropped.queued.id,
    })

    first.finish()
    const next = await upstreamCall(1)
    // 被处理之后再撤，结局是已被处理。
    expect((await withdraw(conversationId, kept.queued.id)).result).toBe('already_consumed')
    next.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls.map((call) => call.messages))).not.toContain('撤回这句')
  })

  it('并发撤回只有一个结局成立', async () => {
    const { conversationId, first } = await busyConversation()
    const target = await queued(await send(conversationId, '可能被撤回的一句'))

    // 两台设备同时撤回，同时当前回复收尾、这一句恰好被取走。
    const race = Promise.all([
      withdraw(conversationId, target.queued.id),
      withdraw(conversationId, target.queued.id),
    ])
    first.finish()
    const results = (await race).map((one) => one.result)

    await Bun.sleep(100)
    const processed = JSON.stringify(calls.map((call) => call.messages)).includes(
      '可能被撤回的一句',
    )
    if (processed) {
      // 被取走了：没有哪一边能说撤回成功。
      expect(results).toEqual(['already_consumed', 'already_consumed'])
    } else {
      expect(results).toEqual(['cancelled', 'cancelled'])
      expect(calls).toHaveLength(1)
    }
    if (processed) (await upstreamCall(1)).finish()
  })

  it('客户端消息 id 幂等：重发不重复入队，也不重复开轮', async () => {
    const { conversationId, first } = await busyConversation()

    const once = await queued(await send(conversationId, '只排一次', 'client-same'))
    const again = await queued(await send(conversationId, '只排一次', 'client-same'))

    expect(again.queued.id).toBe(once.queued.id)
    expect(again.state).toBe('pending')
    expect(await queueList(conversationId)).toHaveLength(1)

    first.finish()
    const next = await upstreamCall(1)
    const consumed = await snapshot(conversationId)
    // 已经被处理之后的重发：告诉客户端是哪一轮处理的，不再开一轮。
    const late = await queued(await send(conversationId, '只排一次', 'client-same'))
    expect(late).toMatchObject({ state: 'consumed', turnId: consumed.activeTurn?.turnId })
    next.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    expect(calls).toHaveLength(2)
  })

  it('空闲时当场开轮的消息重发也不会再开一轮', async () => {
    const conversationId = await startConversation()
    const live = await send(conversationId, '你好', 'client-idle')
    const upstream = await upstreamCall(0)
    upstream.push('你好呀')
    upstream.finish()
    const frames = parseFrames(await live.text())
    const turnStart = frames[0]!.event
    // 当场开轮的那一条不经过排队，事件流里也就没有排队与消费。
    expect(frames.map((frame) => frame.event.type)).toEqual([
      'turnStart',
      'assistantStart',
      'textDelta',
      'turnEnd',
    ])

    const retried = await queued(await send(conversationId, '你好', 'client-idle'))

    expect(retried.state).toBe('consumed')
    expect(retried.turnId).toBe(turnStart.type === 'turnStart' ? turnStart.turnId : '')
    expect(calls).toHaveLength(1)
  })

  it(`超过 ${AGENT_QUEUE_MAX_PENDING} 条时拒收并说明上限`, async () => {
    const { conversationId } = await busyConversation()
    for (let index = 0; index < AGENT_QUEUE_MAX_PENDING; index += 1)
      await queued(await send(conversationId, `第 ${index + 1} 句`))

    const overflow = await send(conversationId, '第十一句')

    expect(overflow.status).toBe(409)
    expect(await overflow.json()).toEqual({
      error: 'queue_full',
      limit: AGENT_QUEUE_MAX_PENDING,
    })
    expect(await queueList(conversationId)).toHaveLength(AGENT_QUEUE_MAX_PENDING)
  })

  it('别人的会话读不到排队列表，也撤不回', async () => {
    const { conversationId } = await busyConversation()
    const target = await queued(await send(conversationId, '我的话'))

    const stranger = { [DEVICE_ID_HEADER]: 'device-stranger' }
    expect((await get(`/api/agent/conversations/${conversationId}/queue`, stranger)).status).toBe(
      404,
    )
    const response = await post(
      `/api/agent/conversations/${conversationId}/queue/${target.queued.id}/withdraw`,
      { deviceId: 'device-stranger' },
    )
    expect(response.status).toBe(404)
    expect(await queueList(conversationId)).toHaveLength(1)
  })
})

describe('升级为插话', () => {
  it('排队消息升级为插话，在当前回复的下一个动作边界生效', async () => {
    const { conversationId, turnId, first } = await busyConversation()
    const kept = await queued(await send(conversationId, '先排着'))
    const target = await queued(await send(conversationId, '改成黑猫'))

    const response = await post(
      `/api/agent/conversations/${conversationId}/queue/${target.queued.id}/interject`,
      { deviceId: DEVICE },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: 'interjected', turnId })
    // 它离开排队列表；另一条仍排着，等这一轮结束。
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([kept.queued.id])

    first.push('好')
    first.finish()
    // 插话进的是同一轮：模型在当前回复结束的那个边界看见它，再回一次上游。
    const steered = await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('改成黑猫')
    expect((await snapshot(conversationId)).activeTurn?.turnId).toBe(turnId)
    const events = (await conversationEvents(conversationId)).map((frame) => frame.event)
    expect(events).toContainEqual({
      type: 'queuedMessageInterjected',
      queueId: target.queued.id,
      turnId,
    })
    expect(events).toContainEqual({
      type: 'interjection',
      messageId: target.queued.id,
      text: '改成黑猫',
    })

    steered.push('改好了')
    steered.finish()
    // 没升级的那条照旧在下一轮处理。
    const next = await upstreamCall(2)
    expect(lastUserText(calls[2]!)).toContain('先排着')
    next.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    expect(calls).toHaveLength(3)
    const users = (await snapshot(conversationId)).messages.filter((one) => one.role === 'user')
    expect(users.map((one) => one.id)).toContain(target.queued.id)
  })

  it('已撤回、不存在或没有在跑的轮时不能升级', async () => {
    const { conversationId, first } = await busyConversation()
    const dropped = await queued(await send(conversationId, '撤回这句'))
    await withdraw(conversationId, dropped.queued.id)

    const interject = async (queueId: string) =>
      (await (
        await post(`/api/agent/conversations/${conversationId}/queue/${queueId}/interject`, {
          deviceId: DEVICE,
        })
      ).json()) as { result: string }

    expect(await interject(dropped.queued.id)).toEqual({ result: 'cancelled' })
    expect(await interject('no-such-message')).toEqual({ result: 'not_found' })

    first.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    expect(calls).toHaveLength(1)
  })

  it('插话归档参考图期间按了停止：那条仍由停止退回，不再开新轮', async () => {
    const store = new GatedObjectStore()
    setObjectStoreForTesting(store)
    const { conversationId, turnId } = await busyConversation()
    const reference = await referenceImage('ref-stop')
    const target = await queued(await sendWithReference(conversationId, '带图的一句', reference))

    store.hold()
    const interjecting = interjectQueued(conversationId, target.queued.id)
    await waitFor(() => store.events.some((event) => event.startsWith('waiting:')), 3_000)

    const stopped = await abortTurn(conversationId, turnId)
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toEqual({
      aborted: true,
      returned: [{ id: target.queued.id, text: '带图的一句', references: [reference] }],
    })

    store.letThrough()
    expect(await (await interjecting).json()).toEqual({ result: 'cancelled' })
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    await Bun.sleep(100)
    expect(calls).toHaveLength(1)
    expect(await queueList(conversationId)).toEqual([])
    const users = (await snapshot(conversationId)).messages.filter((one) => one.role === 'user')
    expect(users.map((one) => one.id)).not.toContain(target.queued.id)
  })

  it('插话归档参考图期间这一轮刚好收尾：那条照旧排着，由下一轮处理且只处理一次', async () => {
    const store = new GatedObjectStore()
    setObjectStoreForTesting(store)
    const { conversationId, turnId, first } = await busyConversation()
    const reference = await referenceImage('ref-late')
    const target = await queued(await sendWithReference(conversationId, '来晚的一句', reference))

    store.hold()
    const interjecting = interjectQueued(conversationId, target.queued.id)
    await waitFor(() => store.events.some((event) => event.startsWith('waiting:')), 3_000)
    first.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn?.turnId !== turnId, 3_000)
    store.letThrough()

    const { result } = (await (await interjecting).json()) as { result: string }
    expect(['not_running', 'already_consumed']).toContain(result)
    const next = await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('来晚的一句')
    next.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    await Bun.sleep(100)
    expect(calls).toHaveLength(2)
    const users = (await snapshot(conversationId)).messages.filter((one) => one.role === 'user')
    expect(users.filter((one) => one.id === target.queued.id)).toHaveLength(1)
  })
})

describe('停止时退回排队消息', () => {
  it('停止当前回复后，未处理的排队消息交还客户端，排队列表清空，不再开轮', async () => {
    const { conversationId, turnId } = await busyConversation()
    const one = await queued(await send(conversationId, '第一句'))
    const two = await queued(await send(conversationId, '第二句'))

    const response = await post(
      `/api/agent/conversations/${conversationId}/turns/${turnId}/abort`,
      {
        deviceId: DEVICE,
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      aborted: true,
      returned: [
        { id: one.queued.id, text: '第一句', references: [] },
        { id: two.queued.id, text: '第二句', references: [] },
      ],
    })
    expect(await queueList(conversationId)).toEqual([])
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    await Bun.sleep(100)
    expect(calls).toHaveLength(1)
    expect((await snapshot(conversationId)).queue).toEqual([])
    // 连着的别的设备据此把它们从排队列表里拿掉。
    const events = (await conversationEvents(conversationId)).map((frame) => frame.event)
    expect(events).toContainEqual({ type: 'queuedMessageWithdrawn', queueId: one.queued.id })
    expect(events).toContainEqual({ type: 'queuedMessageWithdrawn', queueId: two.queued.id })
  })

  it('停止的响应丢了：重发同一个停止请求，拿回同一批消息与参考图', async () => {
    const { conversationId, turnId } = await busyConversation()
    const reference = await referenceImage('ref-returned')
    const one = await queued(await sendWithReference(conversationId, '带图的一句', reference))
    const two = await queued(await send(conversationId, '第二句'))
    const expected = {
      aborted: true,
      returned: [
        { id: one.queued.id, text: '带图的一句', references: [reference] },
        { id: two.queued.id, text: '第二句', references: [] },
      ],
    }

    expect(await (await abortTurn(conversationId, turnId)).json()).toEqual(expected)
    // 这一轮还没收尾时重发，与收尾之后重发，都交还同一批。
    const again = await abortTurn(conversationId, turnId)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual(expected)
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    const late = await abortTurn(conversationId, turnId)
    expect(late.status).toBe(200)
    expect(await late.json()).toEqual(expected)
    expect(calls).toHaveLength(1)
  })

  it('没有退回过消息的轮已经收尾时，停止照旧报找不到', async () => {
    const { conversationId, turnId, first } = await busyConversation()
    first.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)

    expect((await abortTurn(conversationId, turnId)).status).toBe(404)
  })
})

describe('澄清答复插队', () => {
  function answer(conversationId: string, text: string): Promise<Response> {
    return post(`/api/agent/conversations/${conversationId}/turns`, {
      deviceId: DEVICE,
      text,
      clarificationAnswer: true,
    })
  }

  it('忙时收到的澄清答复排在已有排队消息前面处理', async () => {
    const { conversationId, turnId, first } = await busyConversation()
    const earlier = await queued(await send(conversationId, '之前排的'))
    await askClarification(conversationId, turnId)
    const reply = await queued(await answer(conversationId, '选黑色'))

    expect(reply.queued.clarificationAnswer).toBe(true)
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([
      reply.queued.id,
      earlier.queued.id,
    ])

    first.finish()
    const second = await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('选黑色')
    second.finish()
    const third = await upstreamCall(2)
    expect(lastUserText(calls[2]!)).toContain('之前排的')
    third.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
  })

  it('会话没在等澄清答复时，带着答复标记的消息照普通消息排队、占名额', async () => {
    const { conversationId, first } = await busyConversation()
    const earlier = await queued(await send(conversationId, '之前排的'))
    const claimed = await queued(await answer(conversationId, '想插队'))

    expect(claimed.queued.clarificationAnswer).toBeUndefined()
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([
      earlier.queued.id,
      claimed.queued.id,
    ])
    for (let index = 2; index < AGENT_QUEUE_MAX_PENDING; index += 1)
      await queued(await send(conversationId, `第 ${index} 句`))
    expect((await answer(conversationId, '再插一次')).status).toBe(409)

    first.finish()
    await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('之前排的')
  })

  it('智能体停下来问澄清时，之前排着的消息等答复先处理', async () => {
    const { conversationId, first } = await busyConversation()
    const earlier = await queued(await send(conversationId, '之前排的'))

    first.pushToolCall(0, {
      id: 'call-clarify',
      name: 'askClarification',
      args: { question: '猫要什么颜色？', options: ['黑色', '白色'] },
    })
    first.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
    await Bun.sleep(100)
    // 排着的那条没有抢在答复前面开轮。
    expect(calls).toHaveLength(1)
    expect((await queueList(conversationId)).map((one) => one.id)).toEqual([earlier.queued.id])

    const live = await answer(conversationId, '黑色')
    expect(live.status).toBe(200)
    const second = await upstreamCall(1)
    expect(lastUserText(calls[1]!)).toContain('黑色')
    second.push('黑猫来了')
    second.finish()
    await live.text()
    const third = await upstreamCall(2)
    expect(lastUserText(calls[2]!)).toContain('之前排的')
    third.finish()
    await waitFor(async () => (await snapshot(conversationId)).activeTurn === null, 3_000)
  })
})
