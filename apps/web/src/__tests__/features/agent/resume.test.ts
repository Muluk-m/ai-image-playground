// @vitest-environment jsdom
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../features/agent/store'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'
const TURN = 'turn-1'

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' }
const ASSISTANT_START: AgentTurnEvent = { type: 'assistantStart', messageId: 'assistant-1' }
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: TURN,
  durationMs: 12,
  stopReason: 'completed',
  usage: null,
}

/** 服务端的帧带的是会话内序号，不是响应内的计数。 */
function sse(
  frames: readonly { id: number; event: AgentTurnEvent }[],
  truncated = false,
): Response {
  const payload = frames.map((frame) => encodeAgentFrame(frame.id, frame.event)).join('')
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(payload))
        return
      }
      if (truncated) controller.error(new Error('network dropped'))
      else controller.close()
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

let turnResponses: (() => Response)[]
let resumeRequests: { lastEventId: string | null; url: string }[]
let messagesResponse: () => Response
let posted: { url: string; body: unknown }[]

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  if (url.endsWith('/api/agent/conversations') && method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (method === 'POST') {
    posted.push({ url, body: JSON.parse(String(init?.body)) })
    if (url.endsWith('/turns')) return turnResponses.shift()!()
    return Response.json({ ok: true })
  }
  if (url.includes('/events')) {
    resumeRequests.push({ url, lastEventId: new Headers(init?.headers).get('last-event-id') })
    return turnResponses.shift()!()
  }
  return messagesResponse()
})

function state() {
  return useAgentStore.getState()
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnResponses = []
  resumeRequests = []
  posted = []
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turn: 'idle',
    activeTurn: null,
    turns: {},
    error: null,
    loaded: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

// 去重、断点续播与退避本身归 agentClient 管，测在 lib/agentClient.test.ts；
// 这里只钉住面板对各种终局的反应。
describe('断线重连', () => {
  it('起轮的请求压根没发出去时直接判失败，不停在进行中', async () => {
    turnResponses = [
      () => {
        throw new TypeError('offline')
      },
    ]

    await state().send('你好')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('这一轮没有跑完')
  })

  it('轮已经不在了就不再重连，直接判失败', async () => {
    turnResponses = [
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response('{}', { status: 404 }),
    ]

    await state().send('你好')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('这一轮没有跑完')
  })
})

describe('刷新后重新挂上', () => {
  it('读回历史时挂回仍在进行的那一轮', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () =>
      Response.json({
        messages: [
          {
            id: 'user-1',
            turnId: TURN,
            role: 'user',
            content: [{ type: 'text', text: '把背景换成浅木色' }],
            createdAt: 1,
          },
        ],
        activeTurn: { turnId: TURN },
        turns: [],
      })
    turnResponses = [
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: ASSISTANT_START },
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          { id: 4, event: TURN_END },
        ]),
    ]

    await state().load()

    expect(resumeRequests[0]!.lastEventId).toBeNull()
    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '把背景换成浅木色',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        text: '好的',
        streaming: false,
      },
    ])
    expect(state().turn).toBe('idle')
  })
})

describe('先取快照再接增量', () => {
  const USER_MESSAGE = {
    id: 'user-1',
    turnId: TURN,
    role: 'user',
    content: [{ type: 'text', text: '把背景换成浅木色' }],
    createdAt: 1,
  }
  const TURN_FRAMES = [
    { id: 8, event: TURN_START },
    { id: 9, event: ASSISTANT_START },
    { id: 10, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } as const },
    { id: 11, event: { ...TURN_END, cost: { chat: 1, image: 0, video: 0 } } },
  ]

  it('快照带游标时从游标之后接会话级增量，不再把这一轮从头按轮要一遍', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () =>
      Response.json({
        messages: [USER_MESSAGE],
        activeTurn: { turnId: TURN },
        turns: [],
        cursor: 7,
      })
    turnResponses = [() => sse(TURN_FRAMES)]

    await state().load()

    expect(resumeRequests).toHaveLength(1)
    expect(resumeRequests[0]!.url).toBe(
      `http://bff.test/api/agent/conversations/${CONVERSATION}/events`,
    )
    expect(resumeRequests[0]!.lastEventId).toBe('7')
    expect(state().turn).toBe('idle')
    expect(state().messages.map((one) => one.id)).toEqual(['user-1', 'assistant-1'])
  })

  it('另一台设备打开同一会话，看到的面板与一直连着的那台一致', async () => {
    // 这台一直连着：起轮那条流从头看到尾。
    turnResponses = [() => sse(TURN_FRAMES)]
    await state().send('把背景换成浅木色')
    const watched = { messages: state().messages, turns: state().turns, turn: state().turn }

    // 另一台中途打开：先取快照，再从游标接增量。
    useAgentStore.setState({
      conversationId: null,
      messages: [],
      turn: 'idle',
      activeTurn: null,
      turns: {},
      error: null,
      loaded: false,
    })
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () =>
      Response.json({
        messages: [USER_MESSAGE],
        activeTurn: { turnId: TURN },
        turns: [],
        cursor: 7,
      })
    turnResponses = [() => sse(TURN_FRAMES)]
    await state().load()

    expect({ messages: state().messages, turns: state().turns, turn: state().turn }).toEqual(
      watched,
    )
  })
})

describe('另一个标签页占着这个会话', () => {
  const OTHER_TAB_HISTORY = () =>
    Response.json({
      messages: [
        {
          id: 'user-1',
          turnId: TURN,
          role: 'user',
          content: [{ type: 'text', text: '把背景换成浅木色' }],
          createdAt: 1,
        },
      ],
      activeTurn: { turnId: TURN },
      turns: [],
    })

  it('起轮拿到 409 时不报错，转去续播 409 带回来的那一轮', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION })
    messagesResponse = OTHER_TAB_HISTORY
    turnResponses = [
      () => Response.json({ error: 'turn_already_running', turnId: TURN }, { status: 409 }),
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: ASSISTANT_START },
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          { id: 4, event: TURN_END },
        ]),
    ]

    await state().send('再画一只猫')

    expect(state().error).toContain('本次消息未发送')
    expect(state().turn).toBe('idle')
    expect(resumeRequests).toHaveLength(1)
    expect(resumeRequests[0]!.url).toContain(`/turns/${TURN}/events`)
    // 那一轮的用户消息只在服务端，续播前得把历史读回来，否则面板上是个空气泡。
    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: TURN,
        role: 'user',
        text: '把背景换成浅木色',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'assistant-1',
        turnId: TURN,
        role: 'assistant',
        text: '好的',
        streaming: false,
      },
    ])
  })

  it('历史读回来时那一轮刚好跑完，仍按 409 给的轮标识重放它的内容', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION })
    messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
    turnResponses = [
      () => Response.json({ error: 'turn_already_running', turnId: TURN }, { status: 409 }),
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: ASSISTANT_START },
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          { id: 4, event: TURN_END },
        ]),
    ]

    await state().send('再画一只猫')

    expect(resumeRequests[0]!.url).toContain(`/turns/${TURN}/events`)
    expect(state().error).toContain('本次消息未发送')
  })

  it('409 没带轮标识时仍按失败处理', async () => {
    useAgentStore.setState({ conversationId: CONVERSATION })
    turnResponses = [() => Response.json({ error: 'turn_already_running' }, { status: 409 })]

    await state().send('再画一只猫')

    expect(resumeRequests).toHaveLength(0)
    expect(state().turn).toBe('failed')
  })
})

describe('中止', () => {
  it('中止进行中的轮，已经流出来的文字留在面板上', async () => {
    let abortRequested = () => {}
    const abortSeen = new Promise<void>((resolve) => {
      abortRequested = resolve
    })
    turnResponses = [
      () => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder()
            const opening: { id: number; event: AgentTurnEvent }[] = [
              { id: 1, event: TURN_START },
              { id: 2, event: ASSISTANT_START },
              { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
            ]
            for (const frame of opening) {
              controller.enqueue(encoder.encode(encodeAgentFrame(frame.id, frame.event)))
            }
            await abortSeen
            controller.enqueue(
              encoder.encode(
                encodeAgentFrame(4, {
                  type: 'turnEnd',
                  turnId: TURN,
                  durationMs: 3,
                  stopReason: 'aborted',
                  usage: null,
                }),
              ),
            )
            controller.close()
          },
        })
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      },
    ]

    const sending = state().send('画一只猫')
    await vi.waitFor(() => expect(state().activeTurn?.turnId).toBe(TURN))
    await state().abort()
    abortRequested()
    await sending

    expect(posted.map((one) => one.url).filter((url) => url.includes('/abort'))).toHaveLength(1)
    expect(state().turn).toBe('idle')
    expect(state().messages[state().messages.length - 1]).toEqual({
      kind: 'text',
      id: 'assistant-1',
      turnId: 'turn-1',
      role: 'assistant',
      text: '好的',
      streaming: false,
    })
  })
})

describe('插话', () => {
  it('轮进行中再发一句就是插话，不另起一轮', async () => {
    turnResponses = [
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: ASSISTANT_START },
          { id: 3, event: { type: 'interjection', messageId: 'user-2', text: '改成狗' } },
          { id: 4, event: { type: 'assistantStart', messageId: 'assistant-2' } },
          { id: 5, event: { type: 'textDelta', messageId: 'assistant-2', delta: '好，改成狗' } },
          { id: 6, event: TURN_END },
        ]),
    ]
    useAgentStore.setState({
      conversationId: CONVERSATION,
      turn: 'running',
      activeTurn: { turnId: TURN },
      turns: {},
    })

    await state().send('改成狗')

    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toContain(`/turns/${TURN}/interject`)
    expect(posted[0]!.body).toMatchObject({ text: '改成狗' })
  })

  it('插话的消息与随后的回复都进对话流', async () => {
    turnResponses = [
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: ASSISTANT_START },
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          { id: 4, event: { type: 'interjection', messageId: 'user-2', text: '改成狗' } },
          { id: 5, event: { type: 'assistantStart', messageId: 'assistant-2' } },
          { id: 6, event: { type: 'textDelta', messageId: 'assistant-2', delta: '好，改成狗' } },
          { id: 7, event: TURN_END },
        ]),
    ]

    await state().send('画一只猫')

    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '画一只猫',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'assistant-1',
        turnId: 'turn-1',
        role: 'assistant',
        text: '好的',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'user-2',
        turnId: 'turn-1',
        role: 'user',
        text: '改成狗',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'assistant-2',
        turnId: 'turn-1',
        role: 'assistant',
        text: '好，改成狗',
        streaming: false,
      },
    ])
  })
})
