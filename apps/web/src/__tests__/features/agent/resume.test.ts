// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { abortRecoveries } from '../../../features/agent/lib/abortRecovery'
import { useAgentStore } from '../../../features/agent/store'
import { scopedStorageName, setClientStorageScope } from '../../../lib/authScope'
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
let receiptResponse: () => Response | Promise<Response>
let withdrawSubmissionResponse: () => Response | Promise<Response>

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
    if (url.includes('/submissions/') && url.endsWith('/withdraw'))
      return withdrawSubmissionResponse()
    if (url.endsWith('/withdraw')) return Response.json({ result: 'already_consumed' })
    if (url.endsWith('/abort')) return Response.json({ aborted: true, returned: [] })
    return Response.json({ ok: true })
  }
  if (url.includes('/submissions/')) return receiptResponse()
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
  setClientStorageScope(crypto.randomUUID())
  turnResponses = []
  resumeRequests = []
  posted = []
  receiptResponse = () => Response.json({ receipt: null })
  withdrawSubmissionResponse = () =>
    Response.json({
      receipt: {
        state: 'cancelled',
        queued: { id: 'user-1', text: '你好', createdAt: 1 },
      },
    })
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turn: 'idle',
    activeTurn: null,
    turns: {},
    queue: [],
    error: null,
    loaded: false,
    returnedMessagesPending: false,
    returnedMessagesError: null,
  })
})

afterEach(() => {
  setClientStorageScope(null)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

// 去重、断点续播与退避本身归 agentClient 管，测在 lib/agentClient.test.ts；
// 这里只钉住面板对各种终局的反应。
describe('断线重连', () => {
  it('空回执由服务端确认取消后退出进行中，保留草稿供用户重试', async () => {
    turnResponses = [
      () => {
        throw new TypeError('offline')
      },
    ]

    await state().send('你好')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('消息未能加入排队，草稿已保留，请重试。')
    expect(posted.filter((one) => one.url.endsWith('/withdraw'))).toHaveLength(1)
  })

  it('起轮响应丢失后按原消息回执接回已完成的轮', async () => {
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
    ]
    receiptResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', clientMessageId: 'client-1', text: '你好', createdAt: 1 },
        },
      })
    messagesResponse = () =>
      Response.json({
        messages: [],
        activeTurn: null,
        turns: [{ turnId: TURN, durationMs: 12, stopReason: 'completed' }],
      })
    turnResponses.push(() =>
      sse([
        { id: 1, event: TURN_START },
        { id: 2, event: TURN_END },
      ]),
    )
    const accepted = vi.fn()
    await state().send('你好', [], accepted)
    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(accepted).toHaveBeenCalledOnce()
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
    const ids = posted
      .filter((one) => one.url.endsWith('/turns'))
      .map((one) => (one.body as { clientMessageId: string }).clientMessageId)
    expect(ids[0]).toBe(ids[1])
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/submissions/' + ids[0])),
    ).toBe(true)
  })

  it('仅收到心跳后断流，仍按消息回执恢复已受理的轮', async () => {
    turnResponses = [
      () => sse([], true),
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: TURN_END },
        ]),
    ]
    receiptResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    await state().send('你好')
    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(1)
  })

  it('回执暂时为空时先复查，收到已受理回执后恢复原轮', async () => {
    vi.useFakeTimers()
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: TURN_END },
        ]),
    ]
    let lookups = 0
    receiptResponse = () =>
      Response.json({
        receipt:
          ++lookups === 1
            ? null
            : {
                state: 'consumed',
                turnId: TURN,
                queued: { id: 'user-1', text: '你好', createdAt: 1 },
              },
      })
    messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
    const sending = state().send('你好')
    await vi.advanceTimersByTimeAsync(501)
    await vi.runAllTimersAsync()
    await sending
    expect(state().turn).toBe('idle')
    expect(lookups).toBe(2)
  })

  it('多次空回执后通过原子确认发现迟到的已接收提交，仍恢复原轮', async () => {
    vi.useFakeTimers()
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: TURN_END },
        ]),
    ]
    withdrawSubmissionResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    const sending = state().send('你好')
    await vi.advanceTimersByTimeAsync(1001)
    await vi.runAllTimersAsync()
    await sending
    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(posted.filter((one) => one.url.endsWith('/withdraw'))).toHaveLength(1)
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
  })

  it('回执查询暂时离线时保持恢复状态，只查询而不重新提交', async () => {
    vi.useFakeTimers()
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: TURN_END },
        ]),
    ]
    let lookups = 0
    receiptResponse = () => {
      if (++lookups === 1) throw new TypeError('offline')
      return Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', clientMessageId: 'client-1', text: '你好', createdAt: 1 },
        },
      })
    }
    messagesResponse = () =>
      Response.json({
        messages: [],
        activeTurn: null,
        turns: [{ turnId: TURN, durationMs: 12, stopReason: 'completed' }],
      })
    const sending = state().send('你好')
    await vi.advanceTimersByTimeAsync(1)
    expect(state().turn).toBe('running')
    expect(state().reconnecting).toBe(true)
    await vi.advanceTimersByTimeAsync(5_001)
    await vi.runAllTimersAsync()
    await sending
    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(lookups).toBe(2)
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
  })

  it('断流后快照仍在运行，沿用游标接回同一轮且不重复文字', async () => {
    vi.useFakeTimers()
    turnResponses = [
      () =>
        sse(
          [
            { id: 1, event: TURN_START },
            { id: 2, event: ASSISTANT_START },
            { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          ],
          true,
        ),
      () => new Response('{}', { status: 404 }),
      () =>
        sse([
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的' } },
          { id: 4, event: { type: 'textDelta', messageId: 'assistant-1', delta: '完成' } },
          { id: 5, event: TURN_END },
        ]),
    ]
    messagesResponse = () =>
      Response.json({ messages: [], activeTurn: { turnId: TURN }, turns: [] })
    const sending = state().send('你好')
    await vi.advanceTimersByTimeAsync(5_001)
    await sending
    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(state().messages.find((one) => one.id === 'assistant-1')).toMatchObject({
      text: '好的完成',
    })
    expect(resumeRequests[resumeRequests.length - 1]?.lastEventId).toBe('3')
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(1)
  })

  it('断流且快照离线时保留下一轮标记，恢复后继续跟随已消费的排队消息', async () => {
    vi.useFakeTimers()
    let opening!: ReadableStreamDefaultController<Uint8Array>
    turnResponses = [
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              opening = controller
              controller.enqueue(new TextEncoder().encode(encodeAgentFrame(1, TURN_START)))
            },
          }),
        ),
      () =>
        Response.json(
          {
            state: 'consumed',
            turnId: 'turn-2',
            queued: { id: 'user-2', text: '第二句', createdAt: 2 },
          },
          { status: 202 },
        ),
      () => new Response('{}', { status: 404 }),
      () => sse([{ id: 2, event: TURN_END }]),
      () =>
        sse([
          { id: 3, event: { ...TURN_START, turnId: 'turn-2', userMessageId: 'user-2' } },
          { id: 4, event: { ...TURN_END, turnId: 'turn-2' } },
        ]),
    ]
    let snapshots = 0
    messagesResponse = () => {
      if (++snapshots === 1) throw new TypeError('snapshot offline')
      return Response.json({ messages: [], activeTurn: { turnId: 'turn-2' }, turns: [], queue: [] })
    }
    const sending = state().send('第一句')
    await vi.advanceTimersByTimeAsync(1)
    const queued = state().send('第二句')
    await vi.runAllTimersAsync()
    await queued
    opening.error(new TypeError('stream offline'))
    await vi.advanceTimersByTimeAsync(5_001)
    await sending
    await vi.runAllTimersAsync()
    expect(state().turns['turn-2']).toMatchObject({ stopReason: 'completed' })
    expect(state().turn).toBe('idle')
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

  it('流没接上但服务端已经跑完：照快照摆出回复，不判失败', async () => {
    turnResponses = [
      () =>
        sse(
          [
            { id: 1, event: TURN_START },
            { id: 2, event: ASSISTANT_START },
          ],
          true,
        ),
      () => new Response('{}', { status: 404 }),
    ]
    messagesResponse = () =>
      Response.json({
        messages: [
          {
            id: 'user-1',
            turnId: TURN,
            role: 'user',
            content: [{ type: 'text', text: '你好' }],
            createdAt: 1,
          },
          {
            id: 'assistant-1',
            turnId: TURN,
            role: 'assistant',
            content: [{ type: 'text', text: '画布上共有 2 张图片' }],
            createdAt: 2,
          },
        ],
        activeTurn: null,
        turns: [{ turnId: TURN, durationMs: 12, stopReason: 'completed' }],
      })

    await state().send('你好')

    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(state().messages.map((message) => message.kind === 'text' && message.text)).toEqual([
      '你好',
      '画布上共有 2 张图片',
    ])
  })

  it('快照里这一轮也是失败的：照旧判失败', async () => {
    turnResponses = [
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response('{}', { status: 404 }),
    ]
    messagesResponse = () =>
      Response.json({
        messages: [],
        activeTurn: null,
        turns: [{ turnId: TURN, durationMs: 12, stopReason: 'failed' }],
      })

    await state().send('你好')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('这一轮没有跑完')
  })

  it('被打断、已排上续跑的轮不判失败，挂到续跑的那一轮上', async () => {
    const NEXT = 'turn-2'
    turnResponses = [
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response('{}', { status: 404 }),
      () =>
        sse([
          { id: 5, event: { type: 'turnStart', turnId: NEXT, userMessageId: 'user-2' } },
          { id: 6, event: { type: 'assistantStart', messageId: 'assistant-2' } },
          { id: 7, event: { type: 'textDelta', messageId: 'assistant-2', delta: '接着来' } },
          { id: 8, event: { ...TURN_END, turnId: NEXT } },
        ]),
    ]
    messagesResponse = () =>
      Response.json({
        messages: [],
        activeTurn: { turnId: NEXT },
        turns: [
          { turnId: TURN, durationMs: 12, stopReason: 'failed', error: 'agent_turn_interrupted' },
        ],
      })

    await state().send('你好')
    await vi.waitFor(() => expect(state().turn).toBe('idle'))

    expect(state().error).toBeNull()
    expect(
      state().messages.some((message) => message.kind === 'text' && message.text === '接着来'),
    ).toBe(true)
  })

  it('等快照期间面板已经去了别的轮：不把它判失败', async () => {
    turnResponses = [
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response('{}', { status: 404 }),
    ]
    messagesResponse = () => {
      useAgentStore.setState({ activeTurn: { turnId: 'turn-other' } })
      return new Response('{}', { status: 500 })
    }

    await state().send('你好')

    expect(state().turn).toBe('running')
    expect(state().error).toBeNull()
  })
})

describe('刷新后重新挂上', () => {
  it('读回历史时挂回仍在进行的那一轮', async () => {
    localStorage.setItem(scopedStorageName('image-playground.agent_conversation_id'), CONVERSATION)
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
    localStorage.setItem(scopedStorageName('image-playground.agent_conversation_id'), CONVERSATION)
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
    localStorage.setItem(scopedStorageName('image-playground.agent_conversation_id'), CONVERSATION)
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
  it('停止尚未确认时下一句话等待屏障，确认后才提交', async () => {
    let lookups = 0
    receiptResponse = () => {
      lookups += 1
      throw new TypeError('offline')
    }
    let release!: (response: Response) => void
    withdrawSubmissionResponse = () =>
      new Promise((resolve) => {
        release = resolve
      })
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
      () =>
        sse([
          { id: 1, event: { ...TURN_START, turnId: 'next-turn' } },
          { id: 2, event: { ...TURN_END, turnId: 'next-turn' } },
        ]),
    ]
    const first = state().send('你好')
    await vi.waitFor(() => expect(lookups).toBe(1))
    await state().abort()
    await first
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const next = state().send('下一句话')
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
    release(
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      }),
    )
    await next
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(3)
    expect(posted.findIndex((one) => one.url.endsWith('/abort'))).toBeLessThan(
      posted.findIndex((one) => (one.body as { text?: string }).text === '下一句话'),
    )
    expect(state().turn).toBe('idle')
  })

  it('恢复期间停止：排队撤回输给开轮时只停本条消息对应的新轮', async () => {
    withdrawSubmissionResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    let releaseReceipt!: (response: Response) => void
    const receiptReady = new Promise<Response>((resolve) => {
      releaseReceipt = resolve
    })
    let lookups = 0
    receiptResponse = () => {
      lookups += 1
      if (lookups === 1) return receiptReady
      return Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    }
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: { ...TURN_END, stopReason: 'aborted' } },
        ]),
    ]
    messagesResponse = () =>
      Response.json({
        messages: [],
        activeTurn: null,
        turns: [{ turnId: TURN, durationMs: 12, stopReason: 'aborted' }],
      })
    const sending = state().send('你好')
    await vi.waitFor(() => expect(lookups).toBe(1))
    await state().abort()
    releaseReceipt(
      Response.json({
        receipt: {
          state: 'pending',
          turnId: 'previous-turn',
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      }),
    )
    await sending
    await vi.waitFor(async () => expect(await abortRecoveries(CONVERSATION).read()).toEqual([]))
    expect(posted.filter((one) => one.url.endsWith('/abort')).map((one) => one.url)).toEqual([
      'http://bff.test/api/agent/conversations/conversation-1/turns/turn-1/abort',
    ])
    expect(lookups).toBe(1)
    expect(state().turn).toBe('idle')
    expect(state().stopping).toBe(false)
  })

  it('持续离线时停止立即退出等待，重连后按持久消息记录确认中止', async () => {
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
    ]
    let lookups = 0
    receiptResponse = () => {
      lookups += 1
      throw new TypeError('offline')
    }
    withdrawSubmissionResponse = () => {
      throw new TypeError('offline')
    }
    const sending = state().send('你好')
    await vi.waitFor(() => expect(lookups).toBe(1))
    await state().abort()
    expect(state().turn).toBe('idle')
    expect(state().stopping).toBe(false)
    expect(await sending).toBe('cancelled')
    await vi.waitFor(() => expect(state().returnedMessagesError).toBe('fallback'))
    const saved = await abortRecoveries(CONVERSATION).read()
    expect(saved).toHaveLength(1)
    expect(saved[0].clientMessageId).toBe(
      (posted[0].body as { clientMessageId: string }).clientMessageId,
    )
    await state().send('下一句话')
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
    expect(await abortRecoveries(CONVERSATION).read()).toHaveLength(1)
    receiptResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    withdrawSubmissionResponse = () =>
      Response.json({
        receipt: {
          state: 'consumed',
          turnId: TURN,
          queued: { id: 'user-1', text: '你好', createdAt: 1 },
        },
      })
    await state().retryReturnedMessages()
    expect(await abortRecoveries(CONVERSATION).read()).toEqual([])
    expect(posted.filter((one) => one.url.endsWith('/abort'))).toHaveLength(1)
    expect(posted.filter((one) => one.url.endsWith('/turns'))).toHaveLength(2)
  })

  it('停止的撤回请求再次断网时保留恢复记录，重试成功才清除', async () => {
    let release!: (response: Response) => void
    const initial = new Promise<Response>((resolve) => {
      release = resolve
    })
    let lookups = 0
    receiptResponse = () =>
      ++lookups === 1
        ? initial
        : Response.json({
            receipt: {
              state: 'pending',
              turnId: 'previous-turn',
              queued: { id: 'user-1', text: '你好', createdAt: 1 },
            },
          })
    withdrawSubmissionResponse = () => {
      throw new TypeError('offline again')
    }
    turnResponses = [
      () => {
        throw new TypeError('response lost')
      },
      () => {
        throw new TypeError('response lost')
      },
    ]
    const sending = state().send('你好')
    await vi.waitFor(() => expect(lookups).toBe(1))
    await state().abort()
    release(Response.json({ receipt: null }))
    await sending
    await vi.waitFor(() => expect(posted.some((one) => one.url.endsWith('/withdraw'))).toBe(true))
    expect(state().turn).toBe('idle')
    expect(state().returnedMessagesPending).toBe(true)
    expect(await abortRecoveries(CONVERSATION).read()).toHaveLength(1)
    withdrawSubmissionResponse = () =>
      Response.json({
        receipt: { state: 'cancelled', queued: { id: 'user-1', text: '你好', createdAt: 1 } },
      })
    await state().retryReturnedMessages()
    expect(await abortRecoveries(CONVERSATION).read()).toEqual([])
    expect(posted.filter((one) => one.url.endsWith('/abort'))).toHaveLength(0)
  })

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

describe('忙时发送与插话', () => {
  it('轮进行中再发一句进排队列表，不另起一轮也不插话', async () => {
    const queued = {
      id: 'queue-1',
      clientMessageId: 'client-1',
      text: '改成狗',
      referenceCount: 0,
      createdAt: 1,
    }
    turnResponses = [
      () => Response.json({ queued, state: 'pending', turnId: TURN }, { status: 202 }),
    ]
    useAgentStore.setState({
      conversationId: CONVERSATION,
      turn: 'running',
      activeTurn: { turnId: TURN },
      turns: {},
    })

    await state().send('改成狗')

    expect(posted).toHaveLength(1)
    expect(posted[0]!.url).toMatch(new RegExp(`/conversations/${CONVERSATION}/turns$`))
    expect(posted[0]!.body).toMatchObject({ text: '改成狗' })
    expect(state().queue).toEqual([queued])
    expect(state().turn).toBe('running')
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
