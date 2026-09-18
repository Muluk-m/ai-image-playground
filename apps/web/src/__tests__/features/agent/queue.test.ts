// @vitest-environment jsdom
import type {
  AgentMessageQueuedBody,
  AgentQueuedMessageView,
  AgentTurnEvent,
} from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../features/agent/store'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'
const TURN = 'turn-1'
const NEXT_TURN = 'turn-2'

function queuedView(id: string, text: string): AgentQueuedMessageView {
  return { id, clientMessageId: `client-${id}`, text, referenceCount: 0, createdAt: 1 }
}

const QUEUED = queuedView('queue-1', '再加一只狗')

const turnEnd = (turnId: string): AgentTurnEvent => ({
  type: 'turnEnd',
  turnId,
  durationMs: 12,
  stopReason: 'completed',
  usage: null,
})

/** 服务端的帧带的是会话内序号；`hold` 为真时流停在最后一帧之后不收尾，模拟轮还在跑。 */
function sse(frames: readonly { id: number; event: AgentTurnEvent }[]): Response {
  const payload = frames.map((frame) => encodeAgentFrame(frame.id, frame.event)).join('')
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
}

function queuedResponse(body: AgentMessageQueuedBody): Response {
  return Response.json(body, { status: 202 })
}

let turnPosts: { body: Record<string, unknown> }[]
let turnResponse: () => Response
let withdrawResponse: () => Response
let snapshots: (() => Response)[]
let eventResponses: (() => Response)[]

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  if (url.endsWith('/api/agent/conversations') && method === 'POST')
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  if (url.endsWith('/api/agent/conversations')) return Response.json({ conversations: [] })
  if (method === 'POST' && url.endsWith('/turns')) {
    turnPosts.push({ body: JSON.parse(String(init?.body)) })
    return turnResponse()
  }
  if (method === 'POST' && url.includes('/withdraw')) return withdrawResponse()
  if (url.includes('/events')) return eventResponses.shift()!()
  return (snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!)()
})

function state() {
  return useAgentStore.getState()
}

/** 面板正跟着一轮：会话忙。 */
function busy() {
  useAgentStore.setState({
    conversationId: CONVERSATION,
    turn: 'running',
    activeTurn: { turnId: TURN },
    turns: {},
    queue: [],
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnPosts = []
  eventResponses = []
  snapshots = [() => Response.json({ messages: [], activeTurn: null, turns: [], queue: [] })]
  withdrawResponse = () => Response.json({ result: 'cancelled' })
  turnResponse = () => queuedResponse({ queued: QUEUED, state: 'pending', turnId: TURN })
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    turns: {},
    queue: [],
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('忙时发送', () => {
  it('进服务端排队列表并确认发送，不另起一轮也不插话', async () => {
    busy()
    const accepted = vi.fn()

    await state().send('再加一只狗', [], accepted)

    expect(accepted).toHaveBeenCalledOnce()
    expect(turnPosts).toHaveLength(1)
    expect(turnPosts[0]!.body).toMatchObject({ text: '再加一只狗' })
    // 每条消息带一个客户端 id，重发时服务端据此去重。
    expect(typeof turnPosts[0]!.body.clientMessageId).toBe('string')
    expect(state().queue).toEqual([QUEUED])
    expect(state().turn).toBe('running')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/interject'))).toBe(false)
  })

  it('排队满了给出上限提示，不确认发送，草稿留在输入框', async () => {
    busy()
    turnResponse = () => Response.json({ error: 'queue_full', limit: 10 }, { status: 409 })
    const accepted = vi.fn()

    await state().send('第十一句', [], accepted)

    expect(accepted).not.toHaveBeenCalled()
    expect(state().error).toBe('排队已满（最多 10 条），等前面的处理完再发。草稿已保留。')
    expect(state().queue).toEqual([])
    expect(state().turn).toBe('running')
  })

  it('服务端回报这条已不在队里时不确认发送，草稿留着', async () => {
    busy()
    // 例如上一次发送开不了轮被退回、这次是同一个客户端 id 的重发。
    turnResponse = () => queuedResponse({ queued: QUEUED, state: 'cancelled' })
    const accepted = vi.fn()

    await state().send('再加一只狗', [], accepted)

    expect(accepted).not.toHaveBeenCalled()
    expect(state().queue).toEqual([])
    expect(state().error).toBe('消息未能加入排队，草稿已保留，请重试。')
    expect(state().turn).toBe('running')
  })

  it('已被并发的收尾取走时确认发送，但不进排队列表', async () => {
    busy()
    turnResponse = () => queuedResponse({ queued: QUEUED, state: 'consumed', turnId: NEXT_TURN })
    const accepted = vi.fn()

    await state().send('再加一只狗', [], accepted)

    expect(accepted).toHaveBeenCalledOnce()
    expect(state().queue).toEqual([])
    expect(state().error).toBeNull()
  })

  it('网络断在回程时用同一个客户端 id 重发一次', async () => {
    busy()
    let attempts = 0
    turnResponse = () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('network dropped')
      return queuedResponse({ queued: QUEUED, state: 'pending', turnId: TURN })
    }

    await state().send('再加一只狗')

    expect(turnPosts).toHaveLength(2)
    expect(turnPosts[1]!.body.clientMessageId).toBe(turnPosts[0]!.body.clientMessageId)
    expect(state().queue).toEqual([QUEUED])
  })

  it('老服务端回「已有一轮」时照旧插话', async () => {
    busy()
    turnResponse = () =>
      Response.json({ error: 'turn_already_running', turnId: TURN }, { status: 409 })
    const accepted = vi.fn()

    await state().send('改成狗', [], accepted)

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith(`/turns/${TURN}/interject`)),
    ).toBe(true)
    expect(accepted).toHaveBeenCalledOnce()
  })
})

describe('排队列表的来源', () => {
  it('刷新后从快照读回排队列表', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    snapshots = [
      () => Response.json({ messages: [], activeTurn: null, turns: [], queue: [QUEUED] }),
    ]

    await state().load()

    expect(state().queue).toEqual([QUEUED])
  })

  it('跟着的那一轮里的排队、撤回与消费事件同步到列表', async () => {
    const other = queuedView('queue-2', '换成蓝色')
    turnResponse = () =>
      sse([
        { id: 1, event: { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' } },
        { id: 2, event: { type: 'messageQueued', message: QUEUED } },
        { id: 3, event: { type: 'messageQueued', message: other } },
        // 重放的同一条不重复进列表。
        { id: 4, event: { type: 'messageQueued', message: QUEUED } },
        { id: 5, event: { type: 'queuedMessageWithdrawn', queueId: other.id } },
      ])
    // 流在没有终帧时断了；续播接上就收尾。
    eventResponses = [() => sse([{ id: 6, event: turnEnd(TURN) }])]
    snapshots = [() => Response.json({ messages: [], activeTurn: null, turns: [], queue: [] })]

    const seen: string[][] = []
    const unsubscribe = useAgentStore.subscribe((next, previous) => {
      if (next.queue !== previous.queue) seen.push(next.queue.map((one) => one.id))
    })

    await state().send('先画一只猫')

    // 收尾时队里还有一条：面板去读快照，那一条已经不在了就照快照收场。
    await vi.waitFor(() => expect(state().queue).toEqual([]))
    unsubscribe()
    expect(seen).toEqual([['queue-1'], ['queue-1', 'queue-2'], ['queue-1'], []])
  })
})

describe('当前回复结束后', () => {
  it('挂到服务端用排队消息接着开的那一轮上', async () => {
    busy()
    await state().send('再加一只狗')
    expect(state().queue).toEqual([QUEUED])
    useAgentStore.setState({ turn: 'idle', activeTurn: null })
    // 模拟面板跟完了第一轮：服务端马上用排队的那句开了下一轮。
    snapshots = [
      // 第一次看，下一轮还没登记上。
      () => Response.json({ messages: [], activeTurn: null, turns: [], queue: [QUEUED] }),
      () =>
        Response.json({
          messages: [],
          activeTurn: { turnId: NEXT_TURN },
          turns: [],
          queue: [],
          cursor: 6,
        }),
    ]
    eventResponses = [
      () =>
        sse([
          { id: 7, event: { type: 'turnStart', turnId: NEXT_TURN, userMessageId: QUEUED.id } },
          {
            id: 8,
            event: { type: 'queuedMessageConsumed', queueId: QUEUED.id, turnId: NEXT_TURN },
          },
          { id: 9, event: { type: 'assistantStart', messageId: 'assistant-2' } },
          { id: 10, event: { type: 'textDelta', messageId: 'assistant-2', delta: '狗画好了' } },
          { id: 11, event: turnEnd(NEXT_TURN) },
        ]),
    ]

    // 第一轮收尾：面板从 turnEnd 走到空闲，然后去挂下一轮。
    turnResponse = () =>
      sse([
        { id: 1, event: { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' } },
        { id: 2, event: turnEnd(TURN) },
      ])
    snapshots.unshift(() =>
      Response.json({ messages: [], activeTurn: null, turns: [], queue: [QUEUED] }),
    )
    await state().send('先画一只猫')

    await vi.waitFor(() =>
      expect(state().messages[state().messages.length - 1]).toMatchObject({
        id: 'assistant-2',
        text: '狗画好了',
      }),
    )
    expect(state().queue).toEqual([])
    expect(state().turn).toBe('idle')
  })
})

describe('轮到时没能开轮', () => {
  it('队里只剩没能开轮的那几条时不再等下一轮，照快照摆出原因', async () => {
    const failed: AgentQueuedMessageView = { ...QUEUED, failure: 'insufficient_credits' }
    useAgentStore.setState({ queue: [QUEUED] })
    turnResponse = () =>
      sse([
        { id: 1, event: { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' } },
        { id: 2, event: turnEnd(TURN) },
      ])
    snapshots = [
      () => Response.json({ messages: [], activeTurn: null, turns: [], queue: [failed] }),
    ]

    await state().send('先画一只猫')

    await vi.waitFor(() => expect(state().queue).toEqual([failed]))
    const snapshotReads = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/messages'))
    expect(snapshotReads).toHaveLength(1)
    expect(state().turn).toBe('idle')
  })
})

describe('撤回', () => {
  it('撤回成功就从列表里拿掉', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION, queue: [QUEUED] })

    await state().withdrawQueued(QUEUED.id)

    expect(state().queue).toEqual([])
    expect(state().error).toBeNull()
  })

  it('已经被处理了就照实说，列表里同样拿掉', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION, queue: [QUEUED] })
    withdrawResponse = () => Response.json({ result: 'already_consumed' })

    await state().withdrawQueued(QUEUED.id)

    expect(state().queue).toEqual([])
    expect(state().error).toBe('这条消息已经在处理了，没能撤回。')
  })

  it('请求失败时留着那一条并提示重试', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION, queue: [QUEUED] })
    withdrawResponse = () => new Response('{}', { status: 503 })

    await state().withdrawQueued(QUEUED.id)

    expect(state().queue).toEqual([QUEUED])
    expect(state().error).toBe('撤回未成功，请重试。')
  })
})
