import type { AgentTurnEvent } from '@image-playground/shared'
import { DEVICE_ID_HEADER, encodeAgentFrame } from '@image-playground/shared'
import { describe, expect, it, vi } from 'vitest'

const DEVICE = 'device-abcdefgh'

vi.mock('../../../../lib/deviceId', () => ({ getDeviceId: () => DEVICE }))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'https://bff.test' }))
// 真 `resolveMediaSource` 会去回源；这里只关心哪几张走到了它。
const { resolveMediaSource } = vi.hoisted(() => ({
  resolveMediaSource: vi.fn(async (source: string) =>
    source.startsWith('aip-media:') ? 'data:image/png;base64,Y2xvdWQ=' : source,
  ),
}))
vi.mock('../../../../lib/cloudMedia', () => ({
  mediaIdentity: (source: string) => source.match(/^aip-media:([0-9a-f-]{36})$/i)?.[1],
  resolveMediaSource,
}))

import {
  AgentRequestError,
  type AgentTurnStream,
  fetchConversations,
  fetchMessages,
  followTurn,
  interjectTurn,
  startTurn,
  withdrawQueuedMessage,
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

  it('字节已经在云媒体里的只发 id，不把原图下回来再传上去', async () => {
    const mediaId = '7f1a5b3c-2d4e-4f60-8a91-0b2c3d4e5f60'
    const { calls, fetcher } = recordingFetcher({ messageId: 'm1' })
    resolveMediaSource.mockClear()

    await interjectTurn(
      'conv-1',
      'turn-1',
      '改这几张',
      [
        { imageId: 'canvas-1', dataUrl: `aip-media:${mediaId}`, name: '主图' },
        // 画过遮罩的是新像素，云端没有它，只能内联。
        {
          imageId: 'canvas-2',
          dataUrl: `aip-media:${mediaId}`,
          maskDataUrl: 'data:image/png;base64,bWFzaw==',
        },
      ],
      fetcher,
    )

    expect(resolveMediaSource).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(calls[0]!.init?.body)).references).toEqual([
      { imageId: 'canvas-1', mediaId, name: '主图' },
      {
        imageId: 'canvas-2',
        dataUrl: 'data:image/png;base64,Y2xvdWQ=',
        maskDataUrl: 'data:image/png;base64,bWFzaw==',
      },
    ])
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

  it('断流期间报「正在重连」，续播接上后撤掉', async () => {
    const { fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response(null, { status: 502 }),
      () => sse([{ id: 2, event: TURN_END }]),
    ])
    const log: string[] = []

    const turn = followTurn(
      CONVERSATION,
      { turnId: TURN },
      {
        fetcher,
        delaysMs: [0, 0],
        onReconnectingChange: (value) => log.push(value ? 'reconnecting' : 'connected'),
      },
    )
    for await (const event of turn.events) log.push(event.type)

    // 两次重连只报一次「断了」：中间那次失败不让提示闪一下；接上就撤，不等下一帧。
    expect(log).toEqual(['turnStart', 'reconnecting', 'connected', 'turnEnd'])
  })

  it('一直接不上时收场也撤掉「正在重连」', async () => {
    const { fetcher } = scriptedFetcher([
      () => sse([{ id: 1, event: TURN_START }], true),
      () => new Response(null, { status: 500 }),
    ])
    const changes: boolean[] = []

    const turn = followTurn(
      CONVERSATION,
      { turnId: TURN },
      { fetcher, delaysMs: [0], onReconnectingChange: (value) => changes.push(value) },
    )
    await collect(turn)

    expect(turn.outcome).toBe('unreachable')
    expect(changes).toEqual([true, false])
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

  it('断点之后插进来的别的轮，它的内容与终帧都不交给这一轮', async () => {
    const OTHER = 'turn-other'
    const otherStart: AgentTurnEvent = { ...TURN_START, turnId: OTHER }
    const otherEnd: AgentTurnEvent = { ...TURN_END, turnId: OTHER }
    const { fetcher } = scriptedFetcher([
      () =>
        sse(
          [
            { id: 12, event: otherStart },
            { id: 13, event: delta('别处的回复') },
          ],
          true,
        ),
      () =>
        sse([
          { id: 14, event: otherEnd },
          { id: 20, event: TURN_START },
          { id: 21, event: delta('这一轮的') },
          { id: 22, event: TURN_END },
        ]),
    ])

    const turn = followTurn(CONVERSATION, { turnId: TURN, cursor: 11 }, { fetcher, delaysMs: [0] })

    expect(await collect(turn)).toEqual([TURN_START, delta('这一轮的'), TURN_END])
    expect(turn.outcome).toBe('ended')
  })
})

describe('排队消息请求', () => {
  const queued = {
    id: 'queue-1',
    clientMessageId: 'client-1',
    text: '再加一只狗',
    referenceCount: 0,
    createdAt: 1,
  }

  it('忙时发送收到 202 就是已排队，带着客户端消息 id', async () => {
    const calls: Call[] = []
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ queued, state: 'pending', turnId: 'turn-1' }), {
        status: 202,
      })
    }

    const outcome = await startTurn(
      'conv-1',
      '再加一只狗',
      [],
      undefined,
      'image',
      fetcher,
      'client-1',
    )

    expect(outcome).toEqual({
      kind: 'queued',
      body: { queued, state: 'pending', turnId: 'turn-1' },
    })
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      deviceId: DEVICE,
      text: '再加一只狗',
      clientMessageId: 'client-1',
    })
  })

  it('排队已满的 409 带着错误码抛出，而不是当成别处在跑的轮', async () => {
    const fetcher = async () =>
      new Response(JSON.stringify({ error: 'queue_full', limit: 10 }), { status: 409 })

    const failure = await startTurn('conv-1', '第十一句', [], undefined, 'image', fetcher).catch(
      (thrown: unknown) => thrown,
    )

    expect(failure).toBeInstanceOf(AgentRequestError)
    expect(failure).toMatchObject({ status: 409, code: 'queue_full' })
  })

  it('撤回打到那一条的撤回端点，交回服务端裁决的结局', async () => {
    const { calls, fetcher } = recordingFetcher({ result: 'already_consumed' })

    const result = await withdrawQueuedMessage('conv-1', 'queue-1', fetcher)

    expect(result).toBe('already_consumed')
    expect(calls[0]!.url).toBe(
      'https://bff.test/api/agent/conversations/conv-1/queue/queue-1/withdraw',
    )
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ deviceId: DEVICE })
  })
})
