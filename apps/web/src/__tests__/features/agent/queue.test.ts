// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type {
  AgentMessageQueuedBody,
  AgentQueuedMessageView,
  AgentTurnEvent,
} from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { abortRecoveries } from '../../../features/agent/lib/abortRecovery'
import { DraftSession } from '../../../features/agent/lib/drafts'
import { currentProjectDraft } from '../../../features/agent/lib/projectLifecycle'
import { useAgentStore } from '../../../features/agent/store'
import { scopedStorageName, setClientStorageScope } from '../../../lib/authScope'
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
let interjectResponse: () => Response
let abortResponse: (url: string) => Response | Promise<Response>
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
  if (method === 'POST' && url.includes('/queue/') && url.endsWith('/interject'))
    return interjectResponse()
  if (method === 'POST' && url.endsWith('/abort')) return abortResponse(url)
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
  setClientStorageScope(crypto.randomUUID())
  turnPosts = []
  eventResponses = []
  snapshots = [() => Response.json({ messages: [], activeTurn: null, turns: [], queue: [] })]
  withdrawResponse = () => Response.json({ result: 'cancelled' })
  interjectResponse = () => Response.json({ result: 'interjected', turnId: TURN })
  abortResponse = () => Response.json({ aborted: true, returned: [] })
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
    returnedMessagesPending: false,
    returnedMessagesError: null,
  })
})

afterEach(() => {
  setClientStorageScope(null)
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
    localStorage.setItem(scopedStorageName('image-playground.agent_conversation_id'), CONVERSATION)
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
    useAgentStore.setState({ errorDiagnostic: { turnId: 'stale-turn' } })
    withdrawResponse = () => new Response('{}', { status: 503 })

    await state().withdrawQueued(QUEUED.id)

    expect(state().queue).toEqual([QUEUED])
    expect(state().error).toBe('撤回未成功，请重试。')
    expect(state().errorDiagnostic).toMatchObject({ httpStatus: 503 })
    expect(state().errorDiagnostic).not.toHaveProperty('turnId')
  })
})

describe('升级为插话', () => {
  it('插进正在跑的那一轮后从排队列表里拿掉', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })

    await state().interjectQueued(QUEUED.id)

    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith(`/conversations/${CONVERSATION}/queue/${QUEUED.id}/interject`),
      ),
    ).toBe(true)
    expect(state().queue).toEqual([])
    expect(state().error).toBeNull()
  })

  it('那一轮刚好收尾时照旧排着，并说明会在下一轮处理', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    useAgentStore.setState({ errorDiagnostic: { turnId: 'stale-turn' } })
    interjectResponse = () => Response.json({ result: 'not_running' })

    await state().interjectQueued(QUEUED.id)

    expect(state().queue).toEqual([QUEUED])
    expect(state().error).toBe('当前回复已经结束，这条消息会在下一轮处理。')
    expect(state().errorDiagnostic).toBeNull()
  })

  it('另一台设备收到升级事件时同样从列表里拿掉', async () => {
    turnResponse = () =>
      sse([
        { id: 1, event: { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' } },
        { id: 2, event: { type: 'messageQueued', message: QUEUED } },
        {
          id: 3,
          event: { type: 'queuedMessageInterjected', queueId: QUEUED.id, turnId: TURN },
        },
        { id: 4, event: { type: 'interjection', messageId: QUEUED.id, text: QUEUED.text } },
        { id: 5, event: turnEnd(TURN) },
      ])

    await state().send('先画一只猫')

    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    expect(state().queue).toEqual([])
    expect(state().messages.some((one) => one.id === QUEUED.id)).toBe(true)
  })
})

describe('停止时退回', () => {
  it('草稿读取失败时停止退回仍保留队列消息，恢复后再次交接才移除', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const get = IDBObjectStore.prototype.get
    const failure = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (
      this: IDBObjectStore,
      query,
    ) {
      if (this.name === 'drafts') throw new DOMException('Draft unavailable', 'UnknownError')
      return get.call(this, query)
    })
    const draft = currentProjectDraft(CONVERSATION)
    try {
      await draft.ready
      expect(draft.getSnapshot().recoveryBlocked).toBe(true)
      abortResponse = () =>
        Response.json({
          aborted: true,
          returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
        })
      await state().abort()
      expect(state().queue).toEqual([QUEUED])
      expect(draft.getSnapshot().draft.prompt).toBe('')
      failure.mockRestore()
      await draft.retryRecovery()
      await state().abort()
      expect(state().queue).toEqual([])
      expect(draft.getSnapshot().draft.prompt).toBe(QUEUED.text)
      await draft.flush()
    } finally {
      failure.mockRestore()
    }
  })
  it('停止退回超过旧二十张上限的引用仍逐项完整保留，写失败重试不重复正文', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    const references = Array.from({ length: 25 }, (_, index) => ({
      imageId: `returned-${index}`,
      mediaId: `${String(index).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    }))
    abortResponse = () =>
      Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references }],
      })
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'drafts') throw new DOMException('Draft full', 'QuotaExceededError')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    try {
      await state().abort()
      expect(state().queue).toEqual([QUEUED])
      failure.mockRestore()
      await state().abort()
      expect(state().queue).toEqual([])
      expect(draft.getSnapshot().draft.prompt).toBe(QUEUED.text)
      expect(draft.getSnapshot().draft.references.map((one) => one.id)).toEqual(
        references.map((one) => one.imageId),
      )
      await draft.flush()
    } finally {
      failure.mockRestore()
    }
  })
  it('刷新后读回的旧草稿与停止退回消息都能在再次刷新后恢复', async () => {
    const key = scopedStorageName(`agent-draft:${CONVERSATION}`)
    const seed = new DraftSession(key)
    await seed.ready
    seed.update({ prompt: '磁盘旧草稿不能被退回消息覆盖', references: [] })
    await seed.flush()
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    expect(draft.getSnapshot().draft.prompt).toBe('磁盘旧草稿不能被退回消息覆盖')
    expect(draft.getSnapshot().unsent).toBeNull()
    abortResponse = () =>
      Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    await state().abort()
    expect(state().queue).toEqual([])
    const refreshed = new DraftSession(key)
    await refreshed.ready
    expect(JSON.stringify(refreshed.getSnapshot())).toContain('磁盘旧草稿不能被退回消息覆盖')
    expect(JSON.stringify(refreshed.getSnapshot())).toContain(QUEUED.text)
  })
  it('刷新恢复先核实已结束的失效轮，再交接后面的有效退回消息', async () => {
    busy()
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    const seen: string[] = []
    abortResponse = (url) => {
      const old = url.includes(`/turns/${TURN}/abort`)
      seen.push(old ? TURN : NEXT_TURN)
      return old
        ? Response.json({ error: 'turn_not_found' }, { status: 404 })
        : Response.json({
            aborted: true,
            returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
          })
    }
    snapshots = [
      () => {
        throw new TypeError('History temporarily offline')
      },
    ]
    await state().abort()
    expect(state().returnedMessagesPending).toBe(true)
    expect((await abortRecoveries(CONVERSATION).read()).map((one) => one.turnId)).toEqual([TURN])
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'drafts') throw new DOMException('Draft full', 'QuotaExceededError')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    try {
      useAgentStore.setState({
        turn: 'running',
        activeTurn: { turnId: NEXT_TURN },
        stopping: false,
        queue: [QUEUED],
      })
      await state().abort()
      expect((await abortRecoveries(CONVERSATION).read()).map((one) => one.turnId)).toEqual([
        TURN,
        NEXT_TURN,
      ])
      failure.mockRestore()
      snapshots = [() => Response.json({ messages: [], activeTurn: null, turns: [], queue: [] })]
      useAgentStore.setState({
        loaded: false,
        conversationId: null,
        turn: 'idle',
        activeTurn: null,
        queue: [],
        error: null,
      })
      localStorage.setItem(
        scopedStorageName('image-playground.agent_conversation_id'),
        CONVERSATION,
      )
      await state().load()
      expect(seen).toEqual([TURN, NEXT_TURN, TURN, NEXT_TURN])
      expect(await abortRecoveries(CONVERSATION).read()).toEqual([])
      expect(state().returnedMessagesPending).toBe(false)
      expect(state().error).toBeNull()
      const persisted = new DraftSession(draft.key)
      await persisted.ready
      expect(JSON.stringify(persisted.getSnapshot())).toContain(QUEUED.text)
      expect(turnPosts).toEqual([])
    } finally {
      failure.mockRestore()
    }
  })

  it('旧轮恢复遇到新运行轮时跳过旧404并交接后续回执，不停止新轮', async () => {
    busy()
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    const receipts = abortRecoveries(CONVERSATION)
    await receipts.remember({ turnId: TURN, draftKey: draft.key })
    await receipts.remember({ turnId: NEXT_TURN, draftKey: draft.key })
    const liveTurn = 'turn-still-running'
    useAgentStore.setState({ activeTurn: { turnId: liveTurn }, returnedMessagesPending: true })
    snapshots = [
      () => Response.json({ messages: [], activeTurn: { turnId: liveTurn }, turns: [], queue: [] }),
    ]
    const seen: string[] = []
    abortResponse = (url) => {
      seen.push(url)
      if (url.includes(`/turns/${TURN}/abort`))
        return Response.json({ error: 'turn_not_found' }, { status: 404 })
      return Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    }
    await state().retryReturnedMessages()
    expect(seen.map((url) => url.split('/turns/')[1])).toEqual([
      `${TURN}/abort`,
      `${NEXT_TURN}/abort`,
    ])
    expect(await receipts.read()).toEqual([])
    expect(state().activeTurn?.turnId).toBe(liveTurn)
    expect(state().turn).toBe('running')
    expect(state().returnedMessagesPending).toBe(false)
    const refreshed = new DraftSession(draft.key)
    await refreshed.ready
    expect(JSON.stringify(refreshed.getSnapshot())).toContain(QUEUED.text)
    expect(turnPosts).toEqual([])
  })

  it('空退回回执完成时保留读取期间新发送失败的错误和诊断', async () => {
    busy()
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    await abortRecoveries(CONVERSATION).remember({ turnId: TURN, draftKey: draft.key })
    useAgentStore.setState({ returnedMessagesPending: true, returnedMessagesError: 'fallback' })
    let release!: (response: Response) => void
    const waiting = new Promise<Response>((resolve) => {
      release = resolve
    })
    const abort = vi.fn(() => waiting)
    abortResponse = abort
    const recovering = state().retryReturnedMessages()
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce())
    turnResponse = () => Response.json({ error: 'queue_full', limit: 10 }, { status: 409 })
    await state().send('稍后再发的新消息')
    const error = state().error
    const diagnostic = state().errorDiagnostic
    expect(error).toBe('排队已满（最多 10 条），等前面的处理完再发。草稿已保留。')
    release(Response.json({ aborted: true, returned: [] }))
    await recovering
    expect(state().error).toBe(error)
    expect(state().errorDiagnostic).toBe(diagnostic)
    expect(state().returnedMessagesPending).toBe(false)
    expect(await abortRecoveries(CONVERSATION).read()).toEqual([])
  })

  it('后续轮停止成功仍保留前轮尚未交接的恢复入口', async () => {
    busy()
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    abortResponse = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
    await state().abort()
    expect(state().returnedMessagesPending).toBe(true)
    expect((await abortRecoveries(CONVERSATION).read()).map((one) => one.turnId)).toEqual([TURN])
    useAgentStore.setState({ turn: 'running', activeTurn: { turnId: NEXT_TURN }, stopping: false })
    abortResponse = () => Response.json({ aborted: true, returned: [] })
    await state().abort()
    expect((await abortRecoveries(CONVERSATION).read()).map((one) => one.turnId)).toEqual([TURN])
    expect(state().returnedMessagesPending).toBe(true)
    abortResponse = (url) => {
      expect(url).toContain(`/turns/${TURN}/abort`)
      return Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    }
    useAgentStore.setState({ turn: 'idle', activeTurn: null, stopping: false })
    await state().retryReturnedMessages()
    expect(await abortRecoveries(CONVERSATION).read()).toEqual([])
    expect(state().returnedMessagesPending).toBe(false)
    const persisted = new DraftSession(draft.key)
    await persisted.ready
    expect(JSON.stringify(persisted.getSnapshot())).toContain(QUEUED.text)
    expect(turnPosts).toEqual([])
  })

  it('停止恢复标识无法落盘时不停止上游，明确失败后可再次停止', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    const abort = vi.fn(() =>
      Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      }),
    )
    abortResponse = abort
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'stops') throw new DOMException('Stop recovery full', 'QuotaExceededError')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    try {
      await state().abort()
      expect(abort).not.toHaveBeenCalled()
      expect(state().turn).toBe('running')
      expect(state().stopping).toBe(false)
      expect(state().activeTurn?.turnId).toBe(TURN)
      expect(state().queue).toEqual([QUEUED])
      expect(state().returnedMessagesPending).toBe(false)
      expect(state().error).toBe('中止未成功，请点击中止重试。')
      failure.mockRestore()
      await state().abort()
      expect(abort).toHaveBeenCalledTimes(1)
      expect(state().queue).toEqual([])
      expect(draft.getSnapshot().draft.prompt).toBe(QUEUED.text)
    } finally {
      failure.mockRestore()
    }
  })
  it('停止轮已经结束后草稿写失败仍提示并在刷新后按原轮恢复交接', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    turnResponse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(
              new TextEncoder().encode(
                encodeAgentFrame(1, {
                  type: 'turnStart',
                  turnId: TURN,
                  userMessageId: 'original-user',
                }),
              ),
            )
            controller.enqueue(
              new TextEncoder().encode(
                encodeAgentFrame(2, { type: 'messageQueued', message: QUEUED }),
              ),
            )
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    useAgentStore.setState({ conversationId: CONVERSATION })
    const sending = state().send('原始请求')
    await vi.waitFor(() => expect(state().queue).toEqual([QUEUED]))
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    let abortCalls = 0
    abortResponse = async () => {
      abortCalls++
      if (abortCalls === 1) {
        stream.enqueue(
          new TextEncoder().encode(
            encodeAgentFrame(3, { type: 'queuedMessageWithdrawn', queueId: QUEUED.id }),
          ),
        )
        stream.enqueue(new TextEncoder().encode(encodeAgentFrame(4, turnEnd(TURN))))
        stream.close()
        await sending
      }
      return Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    }
    const put = IDBObjectStore.prototype.put
    const failure = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      if (this.name === 'drafts') throw new DOMException('Draft full', 'QuotaExceededError')
      return key === undefined ? put.call(this, value) : put.call(this, value, key)
    })
    try {
      await state().abort()
      expect(state().turn).toBe('idle')
      expect(state().error).toBeTruthy()
      expect(state().returnedMessagesError).toBe('return_handoff_failed')
      expect(state().queue).toEqual([])
      failure.mockRestore()
      // Reopening history has no active turn; recovery must use the saved original stop identity.
      useAgentStore.setState({ loaded: false, error: null, queue: [], conversationId: null })
      localStorage.setItem(
        scopedStorageName('image-playground.agent_conversation_id'),
        CONVERSATION,
      )
      await state().load()
      await vi.waitFor(() => expect(abortCalls).toBe(2))
      expect(state().error).toBeNull()
      expect(turnPosts).toHaveLength(1)
      const persisted = new DraftSession(draft.key)
      await persisted.ready
      expect(JSON.stringify(persisted.getSnapshot())).toContain(QUEUED.text)
      expect(draft.getSnapshot().draft.prompt).toBe(QUEUED.text)
    } finally {
      failure.mockRestore()
    }
  })
  it('停止后未处理的排队消息回到输入框，排队列表清空', async () => {
    busy()
    const other = queuedView('queue-2', '换成蓝色')
    useAgentStore.setState({ queue: [QUEUED, other] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    draft.update((current) => ({ ...current, prompt: '还没发的草稿' }))
    const reference = { imageId: 'image-1', dataUrl: 'data:image/png;base64,aGk=', name: '猫' }
    abortResponse = () =>
      Response.json({
        aborted: true,
        returned: [
          { id: QUEUED.id, text: QUEUED.text, references: [reference] },
          { id: other.id, text: other.text, references: [] },
        ],
      })

    await state().abort()

    expect(state().queue).toEqual([])
    const { prompt, references } = draft.getSnapshot().draft
    expect(prompt).toBe('还没发的草稿\n\n再加一只狗\n\n换成蓝色')
    expect(references).toEqual([{ id: 'image-1', dataUrl: reference.dataUrl, name: '猫' }])
  })
  it('停止的响应丢了就重发同一个请求，拿回的消息照样回到输入框', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    draft.update((current) => ({ ...current, prompt: '' }))
    let attempts = 0
    abortResponse = () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('network down')
      return Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    }

    await state().abort()

    expect(attempts).toBe(2)
    expect(state().error).toBeNull()
    expect(state().queue).toEqual([])
    expect(draft.getSnapshot().draft.prompt).toBe('再加一只狗')
  })

  it('停止期间切到别的会话，退回的消息仍回到按停止时那个会话的输入框', async () => {
    busy()
    useAgentStore.setState({ queue: [QUEUED] })
    const draft = currentProjectDraft(CONVERSATION)
    await draft.ready
    draft.update((current) => ({ ...current, prompt: '' }))
    const other = currentProjectDraft('conversation-2')
    await other.ready
    other.update((current) => ({ ...current, prompt: '另一个会话的草稿' }))
    abortResponse = () => {
      // 响应回来之前用户已经切走了。
      useAgentStore.setState({ conversationId: 'conversation-2', activeTurn: null, turn: 'idle' })
      return Response.json({
        aborted: true,
        returned: [{ id: QUEUED.id, text: QUEUED.text, references: [] }],
      })
    }

    await state().abort()

    expect(draft.getSnapshot().draft.prompt).toBe('再加一只狗')
    expect(other.getSnapshot().draft.prompt).toBe('另一个会话的草稿')
  })
})

describe('回答澄清', () => {
  it('末尾有待作答的澄清时，发出的话标成澄清答复', async () => {
    useAgentStore.setState({
      conversationId: CONVERSATION,
      messages: [
        {
          kind: 'clarification',
          id: 'clarify-1',
          turnId: TURN,
          question: '猫要什么颜色？',
          options: ['黑色', '白色'],
        },
      ],
    })
    turnResponse = () =>
      sse([
        { id: 1, event: { type: 'turnStart', turnId: NEXT_TURN, userMessageId: 'user-2' } },
        { id: 2, event: turnEnd(NEXT_TURN) },
      ])

    await state().send('黑色')

    expect(turnPosts[0]!.body).toMatchObject({ text: '黑色', clarificationAnswer: true })
  })

  it('普通消息不带澄清答复的标记', async () => {
    busy()

    await state().send('再加一只狗')

    expect(turnPosts[0]!.body.clarificationAnswer).toBeUndefined()
  })
})
