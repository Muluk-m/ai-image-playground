// @vitest-environment jsdom
import type {
  AgentBackgroundJobView,
  AgentToolArtifact,
  AgentToolEndEvent,
  AgentToolStartEvent,
  AgentTurnEvent,
} from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../features/agent/lib/videoPoster', () => ({
  captureVideoPoster: async () => POSTER,
  blankVideoPoster: () => POSTER,
}))

import { agentCanvasSink, setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { setAgentJobPollIntervalForTesting, useAgentStore } from '../../../features/agent/store'
import type { AgentToolMessage } from '../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'
const POSTER = 'data:image/png;base64,UE9TVEVS'

const IMAGE: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  media: 'image',
  taskId: 'task-1',
  outputIndex: 0,
  mime: 'image/png',
}

const VIDEO: AgentToolArtifact = {
  artifactId: 'agent_video_1',
  media: 'video',
  taskId: 'task-2',
  outputIndex: 0,
  mime: 'video/mp4',
}

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' }
const TOOL_START: AgentToolStartEvent = {
  type: 'toolStart',
  messageId: 'tool-1',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  title: '一只橘猫坐在窗台上',
}
const TOOL_PROGRESS: AgentTurnEvent = {
  type: 'toolProgress',
  messageId: 'tool-1',
  toolCallId: 'call-1',
  stage: 'running',
}
const TOOL_END: AgentToolEndEvent = {
  type: 'toolEnd',
  messageId: 'tool-1',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  status: 'succeeded',
  title: '一只橘猫坐在窗台上',
  artifacts: [IMAGE],
}
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-1',
  durationMs: 90,
  stopReason: 'completed',
  usage: null,
}

/** 一轮里两次工具调用，各出一张图。 */
function twoToolTurn(): AgentTurnEvent[] {
  const second: AgentToolArtifact = { ...IMAGE, artifactId: 'agent_image_2' }
  return [
    TURN_START,
    TOOL_START,
    TOOL_END,
    { ...TOOL_START, messageId: 'tool-2', toolCallId: 'call-2' },
    { ...TOOL_END, messageId: 'tool-2', toolCallId: 'call-2', artifacts: [second] },
    TURN_END,
  ]
}

function turnStream(...events: AgentTurnEvent[]): Response {
  return new Response(events.map((event, index) => encodeAgentFrame(index + 1, event)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

let turnResponse: () => Response
let messagesResponse: () => Response
/** 后台任务列表：每问一次按当时的服务端结算回。 */
let jobsResponse: () => readonly AgentBackgroundJobView[]
/** 单独取消一个后台任务时服务端的回应。 */
let cancelResponse: () => Response
let imageResponse: () => Response | Promise<Response>
const onCanvas = new Set<string>()
const placed: {
  artifactId: string
  dataUrl: string
  video?: { taskId: string; outputIndex: number }
}[] = []
const anchors: (string | undefined)[] = []
/** 工具起跑时占的位：每次 reserve 记一条，落图时按 placeholderIds 认回去。 */
const reserved: { count: number; anchorObjectId?: string; ids: string[] }[] = []
const discarded: string[] = []
const failed: { id: string; message: string }[] = []
const placedInto: (readonly string[] | undefined)[] = []
let placeholderSeq = 0

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (url.includes('/turns')) return turnResponse()
  if (url.endsWith('/jobs')) return Response.json({ jobs: jobsResponse() })
  if (url.endsWith('/cancel') && init?.method === 'POST') return cancelResponse()
  if (url.includes('/v1/queue/requests/')) {
    return imageResponse()
  }
  return messagesResponse()
})

function state() {
  return useAgentStore.getState()
}

function toolMessages(): AgentToolMessage[] {
  return state().messages.filter((message) => message.kind === 'tool')
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  state().startNewConversation()
  onCanvas.clear()
  placed.length = 0
  anchors.length = 0
  reserved.length = 0
  discarded.length = 0
  failed.length = 0
  placedInto.length = 0
  placeholderSeq = 0
  imageResponse = () =>
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  setAgentCanvasSink({
    has: (objectId) => onCanvas.has(objectId),
    async reserve(request) {
      const ids = Array.from(
        { length: request.count },
        (_, index) => `placeholder-${++placeholderSeq}`,
      )
      reserved.push({ ...request, ids })
      return ids
    },
    discard(ids) {
      discarded.push(...ids)
    },
    markFailed(ids, message) {
      for (const id of ids) failed.push({ id, message })
    },
    async place(items, options) {
      if (options?.isCurrent && !options.isCurrent()) return 'unavailable'
      anchors.push(options?.anchorObjectId)
      placedInto.push(options?.placeholderIds)
      for (const item of items) {
        placed.push(item)
        onCanvas.add(item.artifactId)
      }
      return 'placed'
    },
    focus() {},
    async thumbnail() {
      return null
    },
  })
  turnResponse = () => turnStream(TURN_START, TURN_END)
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
  jobsResponse = () => []
  cancelResponse = () => Response.json({ error: 'not_found' }, { status: 404 })
  setAgentJobPollIntervalForTesting(5)
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turn: 'idle',
    activeTurn: null,
    turns: {},
    error: null,
    loaded: false,
    jobProgress: {},
    toolStartedAt: {},
  })
})

afterEach(() => {
  setAgentJobPollIntervalForTesting()
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

describe('工具事件', () => {
  it('把一次工具调用渲染成一张结果卡并把产出落到画布上', async () => {
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_PROGRESS, TOOL_END, TURN_END)

    await state().send('画一只橘猫')

    expect(toolMessages()).toEqual([
      {
        kind: 'tool',
        id: 'tool-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        artifacts: [IMAGE],
        delivery: 'placed',
      },
    ])
    expect(placed).toEqual([
      {
        artifactId: 'agent_image_1',
        dataUrl: 'data:image/png;base64,AQID',
        taskId: 'task-1',
        name: '一只橘猫坐在窗台上 1',
      },
    ])
  })

  it('改图的产出贴着源图放，源图仍留在画布上', async () => {
    onCanvas.add('canvas-1')
    turnResponse = () =>
      turnStream(
        TURN_START,
        {
          type: 'toolEnd',
          messageId: 'tool-1',
          toolCallId: 'call-1',
          toolName: 'editImage',
          status: 'succeeded',
          title: '把背景换成浅木色',
          artifacts: [IMAGE],
          anchorObjectId: 'canvas-1',
        },
        TURN_END,
      )

    await state().send('把这张的背景换成浅木色')

    expect(anchors).toEqual(['canvas-1'])
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
    expect(onCanvas.has('canvas-1')).toBe(true)
  })

  it('工具一起跑就按数量占位，产物到了落进这些位', async () => {
    const second = { ...IMAGE, artifactId: 'agent_image_2' }
    turnResponse = () =>
      turnStream(
        TURN_START,
        { ...TOOL_START, outputCount: 2 },
        { ...TOOL_END, artifacts: [IMAGE, second] },
        TURN_END,
      )

    await state().send('画两只橘猫')

    expect(reserved).toEqual([
      {
        count: 2,
        title: TOOL_START.title,
        media: 'image',
        messageId: TOOL_START.messageId,
        conversationId: CONVERSATION,
        ids: ['placeholder-1', 'placeholder-2'],
      },
    ])
    expect(placedInto).toEqual([['placeholder-1', 'placeholder-2']])
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1', 'agent_image_2'])
    expect(discarded).toEqual([])
  })

  it('改图的占位贴着被改的那张放', async () => {
    onCanvas.add('canvas-1')
    turnResponse = () =>
      turnStream(
        TURN_START,
        { ...TOOL_START, toolName: 'editImage', outputCount: 1, anchorObjectId: 'canvas-1' },
        { ...TOOL_END, toolName: 'editImage', anchorObjectId: 'canvas-1' },
        TURN_END,
      )

    await state().send('把这张的背景换成浅木色')

    expect(reserved).toEqual([
      {
        count: 1,
        title: TOOL_START.title,
        media: 'image',
        messageId: TOOL_START.messageId,
        conversationId: CONVERSATION,
        anchorObjectId: 'canvas-1',
        ids: ['placeholder-1'],
      },
    ])
    expect(anchors).toEqual(['canvas-1'])
  })

  it('工具失败时占的位就地标错，不留着转圈', async () => {
    turnResponse = () =>
      turnStream(
        TURN_START,
        { ...TOOL_START, outputCount: 2 },
        {
          type: 'toolEnd',
          messageId: 'tool-1',
          toolCallId: 'call-1',
          toolName: 'generateImage',
          status: 'failed',
          title: '一只橘猫坐在窗台上',
          message: '上游拒绝了这张图',
        },
        TURN_END,
      )

    await state().send('画一只橘猫')

    expect(failed).toEqual([
      { id: 'placeholder-1', message: '上游拒绝了这张图' },
      { id: 'placeholder-2', message: '上游拒绝了这张图' },
    ])
    expect(discarded).toEqual([])
  })

  it('续播只收到尾巴、没有 toolStart 时仍然落图', async () => {
    turnResponse = () => turnStream(TURN_START, TOOL_END, TURN_END)

    await state().send('画一只橘猫')

    expect(reserved).toEqual([])
    expect(placedInto).toEqual([undefined])
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
  })

  it('轮中止时没等到产物的占位框被收掉', async () => {
    turnResponse = () =>
      turnStream(
        TURN_START,
        { ...TOOL_START, outputCount: 2 },
        {
          ...TURN_END,
          stopReason: 'aborted',
        },
      )

    await state().send('画一只橘猫')

    expect(discarded).toEqual(['placeholder-1', 'placeholder-2'])
  })

  it('起一轮时把输入框附上的参考图一起发过去', async () => {
    turnResponse = () => turnStream(TURN_START, TURN_END)

    await state().send('把[image 1]的背景换成浅木色', [
      { imageId: 'canvas-1', dataUrl: 'data:image/png;base64,aGk=' },
    ])

    const turnCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/turns'))
    expect(JSON.parse(String(turnCall![1]!.body))).toMatchObject({
      text: '把[image 1]的背景换成浅木色',
      references: [{ imageId: 'canvas-1', dataUrl: 'data:image/png;base64,aGk=' }],
    })
  })

  it('画布上已经有这张图时不重复落一遍', async () => {
    onCanvas.add(IMAGE.artifactId)
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_END, TURN_END)

    await state().send('画一只橘猫')

    expect(placed).toEqual([])
    expect(toolMessages()[0]!.status).toBe('succeeded')
  })

  it('工具失败时卡上写清原因，这一轮算失败', async () => {
    turnResponse = () =>
      turnStream(
        TURN_START,
        TOOL_START,
        {
          type: 'toolEnd',
          messageId: 'tool-1',
          toolCallId: 'call-1',
          toolName: 'generateImage',
          status: 'failed',
          title: '一只橘猫坐在窗台上',
          message: '上游拒绝了这张图',
        },
        {
          type: 'turnEnd',
          turnId: 'turn-1',
          durationMs: 12,
          stopReason: 'failed',
          error: 'agent_tool_failed',
          usage: null,
        },
      )

    await state().send('画一只橘猫')

    expect(toolMessages()[0]).toMatchObject({
      status: 'failed',
      message: '上游拒绝了这张图',
    })
    expect(state().turn).toBe('failed')
    expect(placed).toEqual([])
  })

  it('一轮里连着两次落图，两次产出都写入', async () => {
    turnResponse = () => turnStream(...twoToolTurn())

    await state().send('画两只橘猫')

    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1', 'agent_image_2'])
    expect(toolMessages().map((one) => one.delivery)).toEqual(['placed', 'placed'])
  })
})

describe('产物交付', () => {
  it('会话持有的画布在切换后接收晚到产物，不写新会话也不恢复旧消息', async () => {
    let finishDownload!: (response: Response) => void
    imageResponse = () =>
      new Promise<Response>((resolve) => {
        finishDownload = resolve
      })
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_END, TURN_END)
    const original = agentCanvasSink()!
    original.background = true
    const sending = state().send('画一只橘猫')
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    state().startNewConversation()
    const nextPlace = vi.fn()
    setAgentCanvasSink({ ...original, place: nextPlace })
    finishDownload(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    await sending
    expect(placed.map((one) => one.artifactId)).toEqual([IMAGE.artifactId])
    expect(nextPlace).not.toHaveBeenCalled()
    expect(state().messages).toEqual([])
  })

  it('下载期间离开画布，晚到的产物不再写入旧画布', async () => {
    let finishDownload!: (response: Response) => void
    imageResponse = () =>
      new Promise<Response>((resolve) => {
        finishDownload = resolve
      })
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_END, TURN_END)

    const sending = state().send('画一只橘猫')
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf('function'))
    setAgentCanvasSink(null)
    finishDownload(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    await sending

    expect(placed).toEqual([])
    expect(toolMessages()[0]).toMatchObject({
      status: 'succeeded',
      artifacts: [IMAGE],
      delivery: 'unavailable',
    })
  })
  it('画布挂回来后，它不在时错过的产物自动补落，不用手动放入', async () => {
    let finishDownload!: (response: Response) => void
    imageResponse = () =>
      new Promise<Response>((resolve) => {
        finishDownload = resolve
      })
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_END, TURN_END)
    const sink = agentCanvasSink()!

    const sending = state().send('画一只橘猫')
    await vi.waitFor(() => expect(finishDownload).toBeTypeOf('function'))
    setAgentCanvasSink(null)
    finishDownload(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    await sending
    expect(toolMessages()[0]!.delivery).toBe('unavailable')

    imageResponse = () =>
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    setAgentCanvasSink(sink)
    await vi.waitFor(() => expect(toolMessages()[0]!.delivery).toBe('placed'))
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
    expect(onCanvas.has(IMAGE.artifactId)).toBe(true)
  })

  it('生成完成后文字与下一轮不等交付，切会话使旧下载失效', async () => {
    let finishDownload!: (response: Response) => void
    imageResponse = () =>
      new Promise<Response>((resolve) => {
        finishDownload = resolve
      })
    turnResponse = () =>
      turnStream(
        TURN_START,
        TOOL_START,
        TOOL_END,
        { type: 'assistantStart', messageId: 'assistant-1' },
        { type: 'textDelta', messageId: 'assistant-1', delta: '已生成，请看画布。' },
        TURN_END,
      )
    const sending = state().send('画一只橘猫')
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    expect(state().messages).toContainEqual(
      expect.objectContaining({ text: '已生成，请看画布。', streaming: false }),
    )
    expect(toolMessages()[0]).toMatchObject({ status: 'succeeded', delivery: 'pending' })

    state().startNewConversation()
    finishDownload(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    )
    await sending
    expect(placed).toEqual([])
    expect(state().messages).toEqual([])
    expect(state().conversationId).toBeNull()
  })
})

describe('视频产物', () => {
  it('落画布的是封面加播放来源，mp4 不下载到本地', async () => {
    onCanvas.add('canvas-1')
    turnResponse = () =>
      turnStream(
        TURN_START,
        {
          type: 'toolEnd',
          messageId: 'tool-1',
          toolCallId: 'call-1',
          toolName: 'generateVideo',
          status: 'succeeded',
          title: '视频：让这只猫眨眼',
          artifacts: [VIDEO],
          anchorObjectId: 'canvas-1',
        },
        TURN_END,
      )

    await state().send('让[image 1]动起来')

    expect(placed).toEqual([
      {
        artifactId: 'agent_video_1',
        dataUrl: POSTER,
        taskId: 'task-2',
        name: '视频：让这只猫眨眼 1',
        video: { taskId: 'task-2', outputIndex: 0 },
      },
    ])
    expect(anchors).toEqual(['canvas-1'])
    const downloads = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/v1/queue/requests/'),
    )
    expect(downloads).toEqual([])
  })
})

describe('后台任务', () => {
  const SUBMITTED: AgentToolEndEvent = {
    type: 'toolEnd',
    messageId: 'tool-1',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    status: 'submitted',
    title: '一只橘猫坐在窗台上',
    job: { taskId: 'task-1', media: 'image' },
  }
  const { type: _event, messageId: _id, ...submittedBlock } = SUBMITTED
  const pendingJob: AgentBackgroundJobView = {
    messageId: 'tool-1',
    turnId: 'turn-1',
    result: { ...submittedBlock, type: 'toolResult' },
  }
  const finished = (
    patch: Partial<AgentBackgroundJobView['result']>,
  ): readonly AgentBackgroundJobView[] => [
    { ...pendingJob, result: { ...pendingJob.result, ...patch } },
  ]

  it('轮收尾后占位还在，任务结束时产物落进这个位', async () => {
    let done = false
    jobsResponse = () =>
      done ? finished({ status: 'succeeded', artifacts: [IMAGE] }) : [pendingJob]
    turnResponse = () =>
      turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, SUBMITTED, TURN_END)

    await state().send('画一只橘猫')

    // 轮已经交还，占的位没被当成僵尸收掉。
    expect(state().turn).toBe('idle')
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })
    expect(discarded).toEqual([])
    expect(placed).toEqual([])

    done = true
    await vi.waitFor(() => expect(toolMessages()[0]!.delivery).toBe('placed'))
    expect(toolMessages()[0]).toMatchObject({ status: 'succeeded', artifacts: [IMAGE] })
    expect(placedInto).toEqual([['placeholder-1']])
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
    expect(discarded).toEqual([])
  })

  it('任务失败时占的位就地标错，卡按错误码给出路', async () => {
    jobsResponse = () => finished({ status: 'failed', message: '上游超时', errorCode: 'timeout' })
    turnResponse = () =>
      turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, SUBMITTED, TURN_END)

    await state().send('画一只橘猫')

    await vi.waitFor(() => expect(failed).toHaveLength(1))
    expect(failed[0]!.id).toBe('placeholder-1')
    expect(toolMessages()[0]).toMatchObject({ status: 'failed', errorCode: 'timeout' })
    expect(discarded).toEqual([])
  })

  it('刷新后读回还没结束的任务，接着等它，结束了照常落画布', async () => {
    let done = false
    jobsResponse = () =>
      done ? finished({ status: 'succeeded', artifacts: [IMAGE] }) : [pendingJob]
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'tool-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [pendingJob.result],
            createdAt: 2,
          },
        ],
      })

    await state().selectConversation(CONVERSATION)
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })

    done = true
    await vi.waitFor(() => expect(toolMessages()[0]!.delivery).toBe('placed'))
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
  })

  it('排队的下一条接着开轮时，上一轮交给后台任务的占位不被收掉', async () => {
    let done = false
    jobsResponse = () =>
      done ? finished({ status: 'succeeded', artifacts: [IMAGE] }) : [pendingJob]
    const queued = {
      id: 'queue-1',
      clientMessageId: 'client-queue-1',
      text: '再加一只狗',
      referenceCount: 0,
      createdAt: 1,
    }
    let streams = 0
    turnResponse = () => {
      streams += 1
      return streams === 1
        ? turnStream(
            TURN_START,
            { ...TOOL_START, outputCount: 1 },
            SUBMITTED,
            { type: 'messageQueued', message: queued },
            TURN_END,
          )
        : turnStream(
            { type: 'turnStart', turnId: 'turn-2', userMessageId: 'queue-1' },
            { type: 'queuedMessageConsumed', queueId: 'queue-1', turnId: 'turn-2' },
            { ...TURN_END, turnId: 'turn-2' },
          )
    }
    // 上一轮收尾后服务端已经用排队的那句开了下一轮，任务还没结束。
    messagesResponse = () =>
      Response.json({
        activeTurn: { turnId: 'turn-2' },
        turns: [],
        queue: [],
        messages: [
          {
            id: 'tool-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [pendingJob.result],
            createdAt: 2,
          },
        ],
      })

    await state().send('画一只橘猫')
    await vi.waitFor(() => expect(streams).toBe(2))
    await vi.waitFor(() => expect(state().turn).toBe('idle'))
    expect(state().queue).toEqual([])
    expect(discarded).toEqual([])

    done = true
    await vi.waitFor(() => expect(toolMessages()[0]!.delivery).toBe('placed'))
    expect(placedInto).toEqual([['placeholder-1']])
    expect(discarded).toEqual([])
  })

  it('已用时间从服务端盖在 toolStart 上的时刻算起，刷新或换设备重放后不从零重来', async () => {
    jobsResponse = () => [pendingJob]
    turnResponse = () =>
      turnStream(
        TURN_START,
        { ...TOOL_START, outputCount: 1, startedAt: 1_234 },
        SUBMITTED,
        TURN_END,
      )
    await state().send('画一只橘猫')

    expect(state().toolStartedAt['tool-1']).toBe(1_234)
  })

  it('刷新后立刻从服务端读到任务的阶段与受理时刻，阶段随任务推进', async () => {
    let stage: 'submitted' | 'running' = 'submitted'
    jobsResponse = () => [{ ...pendingJob, progress: { stage, submittedAt: 1_000 } }]
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'tool-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [pendingJob.result],
            createdAt: 2,
          },
        ],
      })

    await state().selectConversation(CONVERSATION)

    await vi.waitFor(() =>
      expect(state().jobProgress['tool-1']).toEqual({ stage: 'submitted', submittedAt: 1_000 }),
    )
    stage = 'running'
    await vi.waitFor(() =>
      expect(state().jobProgress['tool-1']).toEqual({ stage: 'running', submittedAt: 1_000 }),
    )
  })

  it('单独取消后台任务：卡换成取消后的结局，占的位收掉而不是留成失败占位', async () => {
    jobsResponse = () => [pendingJob]
    const cancelCalls: string[] = []
    cancelResponse = () => {
      cancelCalls.push('cancel')
      return Response.json({
        job: finished({ status: 'failed', message: '已中止', errorCode: 'cancelled' })[0],
      })
    }
    turnResponse = () =>
      turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, SUBMITTED, TURN_END)
    await state().send('画一只橘猫')
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })

    await state().cancelJob('tool-1')

    expect(cancelCalls).toHaveLength(1)
    const request = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/cancel'))!
    expect(String(request[0])).toContain(`/conversations/${CONVERSATION}/jobs/task-1/cancel`)
    expect(toolMessages()[0]).toMatchObject({ status: 'failed', errorCode: 'cancelled' })
    await vi.waitFor(() => expect(discarded).toEqual(['placeholder-1']))
    expect(failed).toEqual([])
    expect(placed).toEqual([])
  })

  it('取消请求失败时卡保持原样并把错误交给调用方', async () => {
    jobsResponse = () => [pendingJob]
    cancelResponse = () => Response.json({ error: 'internal' }, { status: 500 })
    turnResponse = () =>
      turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, SUBMITTED, TURN_END)
    await state().send('画一只橘猫')

    await expect(state().cancelJob('tool-1')).rejects.toThrow()
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })
    expect(discarded).toEqual([])

    // 离开会话时移交出去的占位照常收掉，不漏到下一个用例。
    state().startNewConversation()
    await vi.waitFor(() => expect(discarded).toEqual(['placeholder-1']))
  })

  it('切走再切回时旧的占位收掉，任务结束后在当前画布上照常落图', async () => {
    let done = false
    jobsResponse = () =>
      done ? finished({ status: 'succeeded', artifacts: [IMAGE] }) : [pendingJob]
    turnResponse = () =>
      turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, SUBMITTED, TURN_END)
    await state().send('画一只橘猫')
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })

    // 切到另一个会话：移交出去的占位就地收掉，不会在原画布上一直转圈。
    messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
    await state().selectConversation('conversation-2')
    expect(discarded).toEqual(['placeholder-1'])

    // 任务还没结束就切回来：读回的仍是已提交的卡，接着等。
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'tool-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [pendingJob.result],
            createdAt: 2,
          },
        ],
      })
    await state().selectConversation(CONVERSATION)
    expect(toolMessages()[0]).toMatchObject({ status: 'submitted' })

    done = true
    await vi.waitFor(() => expect(toolMessages()[0]!.delivery).toBe('placed'))
    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1'])
  })
})

describe('历史', () => {
  it('历史文字先显示，场景恢复后已有产物显示为已交付且不重复落图', async () => {
    let restored!: () => void
    const ready = new Promise<void>((resolve) => {
      restored = resolve
    })
    setAgentCanvasSink({ ...agentCanvasSink()!, ready })
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'tool-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [
              {
                type: 'toolResult',
                toolCallId: 'call-1',
                toolName: 'generateImage',
                status: 'succeeded',
                title: '一只橘猫坐在窗台上',
                artifacts: [IMAGE],
              },
            ],
            createdAt: 2,
          },
        ],
      })

    await state().selectConversation(CONVERSATION)
    expect(toolMessages()[0]).toMatchObject({ status: 'succeeded', artifacts: [IMAGE] })
    onCanvas.add(IMAGE.artifactId)
    restored()
    await ready

    expect(toolMessages()).toEqual([
      {
        kind: 'tool',
        id: 'tool-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        artifacts: [IMAGE],
        delivery: 'placed',
      },
    ])
    expect(placed).toEqual([])
  })
})

it('工具完成帧在切项目后才到，仍投递原画布而不污染当前会话', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  turnResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller
          controller.enqueue(
            encoder.encode(
              encodeAgentFrame(1, TURN_START) +
                encodeAgentFrame(2, { ...TOOL_START, outputCount: 1 }),
            ),
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  const original = agentCanvasSink()!
  original.background = true
  const sending = state().send('画一只橘猫')
  await vi.waitFor(() => expect(reserved).toHaveLength(1))
  state().startNewConversation()
  const nextPlace = vi.fn()
  setAgentCanvasSink({ ...original, place: nextPlace })
  stream.enqueue(encoder.encode(encodeAgentFrame(3, TOOL_END) + encodeAgentFrame(4, TURN_END)))
  stream.close()
  await sending
  expect(placed.map((one) => one.artifactId)).toEqual([IMAGE.artifactId])
  expect(nextPlace).not.toHaveBeenCalled()
  expect(state().messages).toEqual([])
  expect(state().turn).toBe('idle')
})

it('运行中的项目往返切换只保留一份失败占位', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder()
  turnResponse = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          stream = controller
          controller.enqueue(
            encoder.encode(
              encodeAgentFrame(1, TURN_START) +
                encodeAgentFrame(2, { ...TOOL_START, outputCount: 1 }),
            ),
          )
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
  const original = agentCanvasSink()!
  original.background = true
  const sending = state().send('画一只橘猫')
  await vi.waitFor(() => expect(reserved).toHaveLength(1))
  state().startNewConversation()
  messagesResponse = () =>
    Response.json({ messages: [], turns: [], activeTurn: { turnId: TURN_START.turnId } })
  const failure = {
    ...TOOL_END,
    status: 'failed' as const,
    artifacts: undefined,
    message: '上游失败',
  }
  turnResponse = () => turnStream(TURN_START, { ...TOOL_START, outputCount: 1 }, failure, TURN_END)
  await state().selectConversation(CONVERSATION)
  stream.enqueue(encoder.encode(encodeAgentFrame(3, failure) + encodeAgentFrame(4, TURN_END)))
  stream.close()
  await sending
  expect(failed).toHaveLength(1)
  expect(discarded).toContain('placeholder-1')
})

it('云端交付只刷新原项目，不下载和重复放图；已删占位仅手动放入才恢复', async () => {
  const syncArtifacts = vi.fn(async () => 'unavailable' as const)
  const original = agentCanvasSink()!
  setAgentCanvasSink({ ...original, syncArtifacts })
  turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_END, TURN_END)
  await state().send('云端生成一张图')
  expect(toolMessages()[0]?.delivery).toBe('unavailable')
  expect(syncArtifacts).toHaveBeenCalledOnce()
  expect(placed).toEqual([])
  expect(
    fetchMock.mock.calls.some(([input]) => String(input).includes('/v1/queue/requests/')),
  ).toBe(false)
  // 卸载重挂是自动恢复，不等于用户点了“放入画布”。
  setAgentCanvasSink(null)
  setAgentCanvasSink({ ...original, syncArtifacts })
  await vi.waitFor(() => expect(syncArtifacts).toHaveBeenCalledTimes(2))
  expect(placed).toEqual([])
  await state().placeOnCanvas('tool-1')
  expect(toolMessages()[0]?.delivery).toBe('placed')
  expect(placed).toHaveLength(1)
})
