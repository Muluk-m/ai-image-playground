// @vitest-environment jsdom
import type {
  AgentToolArtifact,
  AgentToolEndEvent,
  AgentToolStartEvent,
  AgentTurnEvent,
} from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../features/agent/lib/videoPoster', () => ({
  videoPosterDataUrl: async () => POSTER,
}))

import { setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../features/agent/store'
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
const onCanvas = new Set<string>()
const placed: {
  artifactId: string
  dataUrl: string
  video?: { taskId: string; outputIndex: number }
}[] = []
/** 画布内容的修订号；测试里手动抬它就等于「用户动了画布」。 */
let revision = 0
const anchors: (string | undefined)[] = []

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (url.includes('/turns')) return turnResponse()
  if (url.includes('/v1/queue/requests/')) {
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
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
  onCanvas.clear()
  placed.length = 0
  revision = 0
  anchors.length = 0
  setAgentCanvasSink({
    has: (objectId) => onCanvas.has(objectId),
    revision: () => revision,
    async place(items, options) {
      const base = options?.baseRevision
      if (base !== undefined && base !== revision) return 'conflict'
      anchors.push(options?.anchorObjectId)
      for (const item of items) {
        placed.push(item)
        onCanvas.add(item.artifactId)
      }
      revision += 1
      return 'placed'
    },
    focus() {},
    async thumbnail() {
      return null
    },
  })
  turnResponse = () => turnStream(TURN_START, TURN_END)
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
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        artifacts: [IMAGE],
      },
    ])
    expect(placed).toEqual([{ artifactId: 'agent_image_1', dataUrl: 'data:image/png;base64,AQID' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bff.test/v1/queue/requests/task-1/image/0',
      expect.anything(),
    )
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

  it('进度事件写到那次调用的卡上', async () => {
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_PROGRESS, TURN_END)

    await state().send('画一只橘猫')

    expect(toolMessages()[0]).toMatchObject({ status: 'running', stage: 'running' })
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

  it('一轮里连着两次落图，第二次不因为第一次的写入误判冲突', async () => {
    turnResponse = () => turnStream(...twoToolTurn())

    await state().send('画两只橘猫')

    expect(placed.map((one) => one.artifactId)).toEqual(['agent_image_1', 'agent_image_2'])
    expect(toolMessages().every((one) => one.canvasConflict !== true)).toBe(true)
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

describe('画布冲突', () => {
  /** 起完这一轮之后用户动了画布：基线取在 send 里，所以这里抬修订号就是冲突。 */
  function editCanvasDuringTurn(...events: AgentTurnEvent[]): void {
    turnResponse = () => {
      revision += 1
      return turnStream(...events)
    }
  }

  it('生成期间画布被改过就不写入，结果卡留住产出并给出手动放入的入口', async () => {
    editCanvasDuringTurn(TURN_START, TOOL_START, TOOL_END, TURN_END)

    await state().send('画一只橘猫')

    expect(placed).toEqual([])
    expect(onCanvas.has(IMAGE.artifactId)).toBe(false)
    expect(toolMessages()[0]).toMatchObject({
      status: 'succeeded',
      artifacts: [IMAGE],
      canvasConflict: true,
    })
  })

  it('手动放入把产出写进画布并撤掉提示', async () => {
    editCanvasDuringTurn(TURN_START, TOOL_START, TOOL_END, TURN_END)
    await state().send('画一只橘猫')

    await state().placeOnCanvas('tool-1')

    expect(placed).toEqual([{ artifactId: 'agent_image_1', dataUrl: 'data:image/png;base64,AQID' }])
    expect(toolMessages()[0]!.canvasConflict).toBeUndefined()
  })

  it('冲突之后这一轮的后续产出照样不写入', async () => {
    editCanvasDuringTurn(...twoToolTurn())

    await state().send('画两只橘猫')

    expect(placed).toEqual([])
    expect(toolMessages().map((one) => one.canvasConflict)).toEqual([true, true])
  })
})

describe('历史', () => {
  it('读回历史时把存下来的工具结果还原成结果卡', async () => {
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

    expect(toolMessages()).toEqual([
      {
        kind: 'tool',
        id: 'tool-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        artifacts: [IMAGE],
      },
    ])
    expect(placed).toEqual([])
  })
})
