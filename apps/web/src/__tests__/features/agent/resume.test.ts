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
    expanded: {},
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('断线重连', () => {
  it('流断在轮结束之前时带 Last-Event-ID 续播，不重复渲染已收到的片段', async () => {
    turnResponses = [
      () =>
        sse(
          [
            { id: 1, event: TURN_START },
            { id: 2, event: ASSISTANT_START },
            { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的，' } },
          ],
          true,
        ),
      () =>
        sse([
          { id: 3, event: { type: 'textDelta', messageId: 'assistant-1', delta: '好的，' } },
          { id: 4, event: { type: 'textDelta', messageId: 'assistant-1', delta: '这就来' } },
          { id: 5, event: TURN_END },
        ]),
    ]

    await state().send('把背景换成浅木色')

    expect(resumeRequests).toHaveLength(1)
    expect(resumeRequests[0]!.lastEventId).toBe('3')
    expect(resumeRequests[0]!.url).toContain(`/turns/${TURN}/events`)
    expect(state().turn).toBe('idle')
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
        text: '好的，这就来',
        streaming: false,
      },
    ])
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
