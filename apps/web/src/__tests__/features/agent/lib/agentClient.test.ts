import type { AgentTurnEvent } from '@image-playground/shared'
import { DEVICE_ID_HEADER, encodeAgentFrame } from '@image-playground/shared'
import { describe, expect, it, vi } from 'vitest'

const DEVICE = 'device-abcdefgh'

vi.mock('../../../../lib/deviceId', () => ({ getDeviceId: () => DEVICE }))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'https://bff.test' }))

import {
  type AgentTurnStream,
  fetchConversations,
  fetchMessages,
  followTurn,
  interjectTurn,
  startTurn,
} from '../../../../features/agent/lib/agentClient'

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** 只记请求，回一个空但形状对的响应；断言全落在请求上。 */
function recordingFetcher(body: unknown) {
  const calls: Call[] = []
  const fetcher = (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
  return { calls, fetcher }
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('agentClient 的设备标识传输位置', () => {
  it('列会话把设备标识放请求头，不放 query string', async () => {
    const { calls, fetcher } = recordingFetcher({ conversations: [] })

    await fetchConversations(fetcher)

    expect(calls[0]!.url).toBe('https://bff.test/api/agent/conversations')
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('读消息把设备标识放请求头，不放 query string', async () => {
    const { calls, fetcher } = recordingFetcher({ messages: [], turns: [], activeTurn: null })

    await fetchMessages('conv-1', fetcher)

    expect(calls[0]!.url).toBe('https://bff.test/api/agent/conversations/conv-1/messages')
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })
})

describe('插话请求', () => {
  it('携带图片和遮罩，并检查服务端拒收', async () => {
    const references = [
      {
        imageId: 'new-image',
        dataUrl: 'data:image/png;base64,aGk=',
        maskDataUrl: 'data:image/png;base64,bWFzaw==',
      },
    ]
    const { calls, fetcher } = recordingFetcher({ messageId: 'm1' })
    await interjectTurn('conv-1', 'turn-1', '改这张', references, fetcher)
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      deviceId: DEVICE,
      text: '改这张',
      references,
    })
    await expect(
      interjectTurn(
        'conv-1',
        'turn-1',
        '改这张',
        references,
        async () => new Response(null, { status: 409 }),
      ),
    ).rejects.toMatchObject({ status: 409 })
  })
})

const CONVERSATION = 'conv-1'
const TURN = 'turn-1'
const EVENTS_URL = `https://bff.test/api/agent/conversations/${CONVERSATION}/turns/${TURN}/events`

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' }
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: TURN,
  durationMs: 12,
  stopReason: 'completed',
  usage: null,
}
const delta = (text: string): AgentTurnEvent => ({
  type: 'textDelta',
  messageId: 'assistant-1',
  delta: text,
})

/** 帧带的是会话内序号，不是这次响应里的计数；`truncated` 模拟半路被掐断。 */
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

/** 按脚本依次作答，并记下每一次请求；脚本用完还来请求就是多发了。 */
function scriptedFetcher(script: readonly (() => Response)[]) {
  const calls: Call[] = []
  const queue = [...script]
  const fetcher = (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (!next) return Promise.reject(new Error(`脚本外的请求：${url}`))
    return Promise.resolve(next())
  }
  return { calls, fetcher }
}

async function collect(turn: AgentTurnStream): Promise<AgentTurnEvent[]> {
  const events: AgentTurnEvent[] = []
  for await (const event of turn.events) events.push(event)
  return events
}

describe('跟一轮到底', () => {
  it('断在半路时带断点续播，重发过的帧不再交第二遍', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () =>
        sse(
          [
            { id: 1, event: TURN_START },
            { id: 2, event: delta('好的，') },
          ],
          true,
        ),
      () =>
        sse([
          { id: 2, event: delta('好的，') },
          { id: 3, event: delta('这就来') },
          { id: 4, event: TURN_END },
        ]),
    ])
    const started = await startTurn(
      CONVERSATION,
      '把背景换成浅木色',
      [],
      undefined,
      undefined,
      fetcher,
    )
    if (started.kind !== 'frames') throw new Error('起轮没拿到帧流')

    const turn = followTurn(CONVERSATION, { frames: started.frames }, { fetcher, delaysMs: [0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START, delta('好的，'), delta('这就来'), TURN_END])
    expect(turn.outcome).toBe('ended')
    expect(calls).toHaveLength(2)
    expect(calls[1]!.url).toBe(EVENTS_URL)
    // 断点就是见过的最后一帧；轮标识是从 turnStart 里学到的。
    expect(headerOf(calls[1]!.init, 'last-event-id')).toBe('2')
    expect(headerOf(calls[1]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('已知轮标识时从头要一遍，设备标识仍走请求头', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: TURN_END },
        ]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START, TURN_END])
    expect(turn.outcome).toBe('ended')
    expect(calls[0]!.url).toBe(EVENTS_URL)
    expect(headerOf(calls[0]!.init, 'last-event-id')).toBeNull()
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('有进展就把退避复位，接得上就一直接下去', async () => {
    // 退避表只留一格：不复位的话第一次重连之后就再也接不上了。
    const { calls, fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => sse([{ id: 2, event: delta('一') }], true),
      () => sse([{ id: 3, event: delta('二') }], true),
      () => sse([{ id: 4, event: TURN_END }]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START, delta('一'), delta('二'), TURN_END])
    expect(turn.outcome).toBe('ended')
    expect(calls).toHaveLength(4)
    expect(calls.map((call) => headerOf(call.init, 'last-event-id'))).toEqual([null, '1', '2', '3'])
  })

  it('退避表用尽就报接不上', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
      () => new Response(null, { status: 500 }),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0, 0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START])
    expect(turn.outcome).toBe('unreachable')
    expect(calls).toHaveLength(4)
  })

  it('还没读到轮标识就断了，没有轮可以接', async () => {
    const { calls, fetcher } = scriptedFetcher([() => sse([], true)])
    const started = await startTurn(CONVERSATION, '画一只猫', [], undefined, undefined, fetcher)
    if (started.kind !== 'frames') throw new Error('起轮没拿到帧流')

    const turn = followTurn(CONVERSATION, { frames: started.frames }, { fetcher, delaysMs: [0] })

    expect(await collect(turn)).toEqual([])
    expect(turn.outcome).toBe('unreachable')
    expect(calls).toHaveLength(1)
  })

  it('轮已经不在了就不再重连', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response('{}', { status: 404 }),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0, 0, 0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START])
    expect(turn.outcome).toBe('gone')
    expect(calls).toHaveLength(2)
  })

  it('被限流时就此收场，不接着重连', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => Response.json({ error: 'rate_limited' }, { status: 429 }),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0, 0, 0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START])
    expect(turn.outcome).toBe('rateLimited')
    expect(calls).toHaveLength(2)
  })

  it('读到终帧就收工，后面断没断都不再发请求', async () => {
    // 终帧之后这条连接照样会断，跟到底的人不该因此再去续播一次。
    const { calls, fetcher } = scriptedFetcher([
      () =>
        sse(
          [
            { id: 1, event: TURN_START },
            { id: 2, event: TURN_END },
          ],
          true,
        ),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START, TURN_END])
    expect(turn.outcome).toBe('ended')
    expect(calls).toHaveLength(1)
  })

  it('调用方叫停之后不再续播', async () => {
    let following = true
    const { calls, fetcher } = scriptedFetcher([() => sse([{ id: 1, event: TURN_START }], true)])

    const turn = followTurn(
      CONVERSATION,
      { turnId: TURN },
      { fetcher, delaysMs: [0], shouldContinue: () => following },
    )
    const events: AgentTurnEvent[] = []
    for await (const event of turn.events) {
      events.push(event)
      following = false
    }

    expect(events).toEqual([TURN_START])
    expect(turn.outcome).toBe('stopped')
    expect(calls).toHaveLength(1)
  })

  it('调用方自己走掉之后不再读、也不再发请求', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () =>
        sse([
          { id: 1, event: TURN_START },
          { id: 2, event: delta('好的') },
          { id: 3, event: TURN_END },
        ]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN }, { fetcher, delaysMs: [0] })
    for await (const event of turn.events) {
      expect(event).toEqual(TURN_START)
      break
    }

    expect(turn.outcome).toBe('stopped')
    expect(calls).toHaveLength(1)
  })
})

describe('先取快照再接会话增量', () => {
  const CONVERSATION_EVENTS_URL = `https://bff.test/api/agent/conversations/${CONVERSATION}/events`

  it('从快照游标之后接会话级增量，断了带最后序号重连，读到这一轮的终帧收工', async () => {
    const { calls, fetcher } = scriptedFetcher([
      () =>
        sse(
          [
            { id: 8, event: TURN_START },
            { id: 9, event: delta('好的，') },
          ],
          true,
        ),
      () =>
        sse([
          { id: 9, event: delta('好的，') },
          { id: 10, event: delta('这就来') },
          { id: 11, event: TURN_END },
        ]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN, cursor: 7 }, { fetcher, delaysMs: [0] })
    const events = await collect(turn)

    expect(events).toEqual([TURN_START, delta('好的，'), delta('这就来'), TURN_END])
    expect(turn.outcome).toBe('ended')
    expect(calls.map((call) => call.url)).toEqual([
      CONVERSATION_EVENTS_URL,
      CONVERSATION_EVENTS_URL,
    ])
    expect(calls.map((call) => headerOf(call.init, 'last-event-id'))).toEqual(['7', '9'])
    expect(headerOf(calls[0]!.init, DEVICE_ID_HEADER)).toBe(DEVICE)
  })

  it('游标之后别的轮的终帧不算这一轮的结局', async () => {
    const earlier: AgentTurnEvent = { ...TURN_END, turnId: 'turn-0', stopReason: 'failed' }
    const { fetcher } = scriptedFetcher([
      () =>
        sse([
          { id: 4, event: earlier },
          { id: 5, event: TURN_START },
          { id: 6, event: TURN_END },
        ]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN, cursor: 3 }, { fetcher, delaysMs: [0] })

    expect(await collect(turn)).toEqual([TURN_START, TURN_END])
    expect(turn.outcome).toBe('ended')
  })
})
