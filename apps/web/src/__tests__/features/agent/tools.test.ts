// @vitest-environment jsdom
import type { AgentToolImage, AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../features/agent/store'
import type { AgentToolMessage } from '../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'

const IMAGE: AgentToolImage = {
  imageId: 'agent_image_1',
  taskId: 'task-1',
  outputIndex: 0,
  mime: 'image/png',
}

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' }
const TOOL_START: AgentTurnEvent = {
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
const TOOL_END: AgentTurnEvent = {
  type: 'toolEnd',
  messageId: 'tool-1',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  status: 'succeeded',
  title: '一只橘猫坐在窗台上',
  images: [IMAGE],
}
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-1',
  durationMs: 90,
  stopReason: 'completed',
  usage: null,
}

function turnStream(...events: AgentTurnEvent[]): Response {
  return new Response(events.map((event, index) => encodeAgentFrame(index + 1, event)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

let turnResponse: () => Response
let messagesResponse: () => Response
const onCanvas = new Set<string>()
const placed: { imageId: string; dataUrl: string }[] = []

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
  setAgentCanvasSink({
    has: (imageId) => onCanvas.has(imageId),
    async place(items) {
      for (const item of items) {
        placed.push(item)
        onCanvas.add(item.imageId)
      }
    },
    focus() {},
    async thumbnail() {
      return null
    },
  })
  turnResponse = () => turnStream(TURN_START, TURN_END)
  messagesResponse = () => Response.json({ messages: [], activeTurn: null })
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turn: 'idle',
    activeTurn: null,
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
        toolCallId: 'call-1',
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        images: [IMAGE],
      },
    ])
    expect(placed).toEqual([{ imageId: 'agent_image_1', dataUrl: 'data:image/png;base64,AQID' }])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bff.test/v1/queue/requests/task-1/image/0',
      expect.anything(),
    )
  })

  it('进度事件写到那次调用的卡上', async () => {
    turnResponse = () => turnStream(TURN_START, TOOL_START, TOOL_PROGRESS, TURN_END)

    await state().send('画一只橘猫')

    expect(toolMessages()[0]).toMatchObject({ status: 'running', stage: 'running' })
  })

  it('画布上已经有这张图时不重复落一遍', async () => {
    onCanvas.add(IMAGE.imageId)
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

  it('读回历史时把存下来的工具结果还原成结果卡', async () => {
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
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
                images: [IMAGE],
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
        toolCallId: 'call-1',
        title: '一只橘猫坐在窗台上',
        status: 'succeeded',
        images: [IMAGE],
      },
    ])
    expect(placed).toEqual([])
  })
})
