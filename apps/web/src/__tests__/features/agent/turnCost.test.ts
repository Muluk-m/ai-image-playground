// @vitest-environment jsdom
import type { AgentTurnEvent, AgentTurnSummaryView } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { settledMock } = vi.hoisted(() => ({ settledMock: vi.fn() }))
// 只替换这一个导出：privateOverlay 的其它导出还有别的模块在用。
vi.mock('../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/privateOverlay')>()),
  notifyPrivateSubmissionSettled: settledMock,
}))

import { useAgentStore } from '../../../features/agent/store'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'

function frames(startId: number, ...events: AgentTurnEvent[]): string {
  return events.map((event, index) => encodeAgentFrame(startId + index, event)).join('')
}

function sseResponse(payload: string): Response {
  return new Response(payload, { headers: { 'content-type': 'text/event-stream' } })
}

const TURN_START: AgentTurnEvent = {
  type: 'turnStart',
  turnId: 'turn-1',
  userMessageId: 'user-1',
  reservedCredits: 60,
}

function turnEnd(event: Partial<AgentTurnEvent> = {}): AgentTurnEvent {
  return {
    type: 'turnEnd',
    turnId: 'turn-1',
    durationMs: 70_000,
    stopReason: 'completed',
    usage: null,
    cost: { chat: 42, image: 85, video: 0 },
    ...event,
  } as AgentTurnEvent
}

let turnResponses: Array<() => Response>
let messagesPayload: unknown

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (url.endsWith('/api/agent/conversations')) return Response.json({ conversations: [] })
  if (url.includes('/turns')) return (turnResponses.shift() ?? (() => sseResponse('')))()
  return Response.json(messagesPayload)
})

function state() {
  return useAgentStore.getState()
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnResponses = []
  messagesPayload = { messages: [], activeTurn: null, turns: [] }
  useAgentStore.setState({
    conversationId: null,
    conversations: [],
    messages: [],
    turns: {},
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('本轮消耗', () => {
  it('进行中记下预扣数，结算后换成实际消耗', async () => {
    let running: unknown
    turnResponses = [
      () => sseResponse(frames(1, TURN_START)),
      () => {
        running = state().turns['turn-1']
        return sseResponse(frames(2, turnEnd()))
      },
    ]

    await state().send('画一只猫')

    expect(running).toEqual({ turnId: 'turn-1', reservedCredits: 60 })
    expect(state().turns['turn-1']).toEqual({
      turnId: 'turn-1',
      reservedCredits: 60,
      durationMs: 70_000,
      stopReason: 'completed',
      cost: { chat: 42, image: 85, video: 0 },
    })
  })

  it('每条消息记下自己属于哪一轮', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(
            1,
            TURN_START,
            { type: 'assistantStart', messageId: 'assistant-1' },
            { type: 'textDelta', messageId: 'assistant-1', delta: '好' },
            turnEnd(),
          ),
        ),
    ]

    await state().send('画一只猫')

    expect(state().messages.map((message) => message.turnId)).toEqual(['turn-1', 'turn-1'])
  })

  it('失败的轮消耗是零，页脚据此写本轮免费', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(
            1,
            TURN_START,
            turnEnd({
              stopReason: 'failed',
              cost: { chat: 0, image: 0, video: 0 },
            } as Partial<AgentTurnEvent>),
          ),
        ),
    ]

    await state().send('画一只猫')

    expect(state().turns['turn-1']).toMatchObject({
      stopReason: 'failed',
      cost: { chat: 0, image: 0, video: 0 },
    })
  })

  it('被打断、已排上中断续跑的轮不报失败，页脚记下错误码', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(
            1,
            TURN_START,
            turnEnd({
              stopReason: 'failed',
              error: 'agent_turn_interrupted',
              cost: { chat: 0, image: 0, video: 0 },
            } as Partial<AgentTurnEvent>),
          ),
        ),
    ]

    await state().send('画一只猫')

    expect(state().turn).toBe('idle')
    expect(state().error).toBeNull()
    expect(state().turns['turn-1']).toMatchObject({
      stopReason: 'failed',
      error: 'agent_turn_interrupted',
    })
  })

  it('真的失败了照旧报失败', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(
            1,
            TURN_START,
            turnEnd({ stopReason: 'failed', error: 'agent_run_failed' } as Partial<AgentTurnEvent>),
          ),
        ),
    ]

    await state().send('画一只猫')

    expect(state().turn).toBe('failed')
    expect(state().error).not.toBeNull()
  })

  it('计费关着的部署里轮上没有任何金额', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(
            1,
            { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' },
            {
              type: 'turnEnd',
              turnId: 'turn-1',
              durationMs: 1_200,
              stopReason: 'completed',
              usage: null,
            },
          ),
        ),
    ]

    await state().send('画一只猫')

    expect(state().turns['turn-1']).toEqual({
      turnId: 'turn-1',
      durationMs: 1_200,
      stopReason: 'completed',
    })
  })

  it('读回历史时把每轮的页脚带回来', async () => {
    const turns: AgentTurnSummaryView[] = [
      {
        turnId: 'turn-1',
        durationMs: 70_000,
        stopReason: 'completed',
        cost: { chat: 42, image: 85, video: 0 },
      },
      { turnId: 'turn-2', durationMs: 3_000, stopReason: 'aborted' },
    ]
    messagesPayload = { messages: [], activeTurn: null, turns }

    await state().selectConversation(CONVERSATION)

    expect(state().turns['turn-1']).toEqual(turns[0])
    expect(state().turns['turn-2']).toEqual(turns[1])
  })
})

describe('顶栏余额', () => {
  it('一轮跑完就通知私有 overlay 重拉余额', async () => {
    turnResponses = [() => sseResponse(frames(1, TURN_START, turnEnd()))]

    await state().send('画一只猫')

    expect(settledMock).toHaveBeenCalledTimes(1)
  })

  it('失败的轮同样通知：预扣要退回来', async () => {
    turnResponses = [
      () =>
        sseResponse(
          frames(1, TURN_START, turnEnd({ stopReason: 'failed' } as Partial<AgentTurnEvent>)),
        ),
    ]

    await state().send('画一只猫')

    expect(settledMock).toHaveBeenCalledTimes(1)
  })

  it('工具任务自己结算，轮还没完也先刷一次', async () => {
    const toolFailed: AgentTurnEvent = {
      type: 'toolEnd',
      messageId: 'tool-1',
      toolCallId: 'call-1',
      toolName: 'generateImage',
      status: 'failed',
      title: '一只橘猫坐在窗台上',
      message: '上游拒绝了这张图',
    }
    turnResponses = [() => sseResponse(frames(1, TURN_START, toolFailed, turnEnd()))]

    await state().send('画一只猫')

    expect(settledMock).toHaveBeenCalledTimes(2)
  })
})
