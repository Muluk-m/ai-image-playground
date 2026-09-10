// @vitest-environment jsdom
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../features/agent/store'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'

function frames(...events: AgentTurnEvent[]): string {
  return events.map((event, index) => encodeAgentFrame(index + 1, event)).join('')
}

/** 逐块投喂，把「一帧被拆到两个 chunk 里」这件事也走一遍。 */
function sseResponse(payload: string, chunkSize = 7): Response {
  const encoder = new TextEncoder()
  let offset = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(payload.slice(offset, offset + chunkSize)))
      offset += chunkSize
    },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' }
const ASSISTANT_START: AgentTurnEvent = { type: 'assistantStart', messageId: 'assistant-1' }
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-1',
  durationMs: 1200,
  stopReason: 'completed',
  usage: null,
}

function turnStream(...events: AgentTurnEvent[]): Response {
  return sseResponse(frames(...events))
}

let turnResponse: () => Response
let messagesResponse: () => Response

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (url.includes('/turns')) return turnResponse()
  return messagesResponse()
})

function state() {
  return useAgentStore.getState()
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnResponse = () => turnStream(TURN_START)
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
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('一轮对话', () => {
  it('把逐字增量拼成助手回复，轮结束后回到 idle', async () => {
    turnResponse = () =>
      turnStream(
        TURN_START,
        ASSISTANT_START,
        { type: 'textDelta', messageId: 'assistant-1', delta: '好的，' },
        { type: 'textDelta', messageId: 'assistant-1', delta: '我把背景换成浅木色' },
        TURN_END,
      )

    const sending = state().send('把背景换成浅木色')
    expect(state().turn).toBe('running')
    await sending

    expect(state().turn).toBe('idle')
    expect(state().messages).toEqual([
      { id: 'user-1', role: 'user', text: '把背景换成浅木色', streaming: false },
      { id: 'assistant-1', role: 'assistant', text: '好的，我把背景换成浅木色', streaming: false },
    ])
  })

  it('开新会话时先建会话并记住它', async () => {
    turnResponse = () => turnStream(TURN_START, TURN_END)

    await state().send('第一句')

    expect(state().conversationId).toBe(CONVERSATION)
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBe(CONVERSATION)
    expect(fetchMock.mock.calls[0]![0]).toBe('http://bff.test/api/agent/conversations')
  })

  it('错误事件让这一轮失败并撤掉半截的回复', async () => {
    turnResponse = () =>
      turnStream(TURN_START, ASSISTANT_START, {
        type: 'turnEnd',
        turnId: 'turn-1',
        durationMs: 8,
        stopReason: 'failed',
        error: 'agent_upstream_error',
      })

    await state().send('把背景换成浅木色')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('这一轮没有跑完')
    expect(state().messages.map((message) => message.role)).toEqual(['user'])
  })

  it('空白消息不发', async () => {
    await state().send('   ')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(state().turn).toBe('idle')
  })
})

describe('读回历史', () => {
  it('刷新后读回上次会话的全部消息', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        messages: [
          {
            id: 'user-1',
            turnId: 'turn-1',
            role: 'user',
            content: [{ type: 'text', text: '第一句' }],
            createdAt: 1,
          },
          {
            id: 'assistant-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            createdAt: 2,
          },
        ],
      })

    await state().load()

    expect(state().conversationId).toBe(CONVERSATION)
    expect(state().messages).toEqual([
      { id: 'user-1', role: 'user', text: '第一句', streaming: false },
      { id: 'assistant-1', role: 'assistant', text: '好的', streaming: false },
    ])
  })

  it('会话已经不在时忘掉它', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => new Response('{}', { status: 404 })

    await state().load()

    expect(state().conversationId).toBeNull()
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBeNull()
  })
})

describe('折叠', () => {
  it('展开状态按消息切换', () => {
    state().toggleExpanded('assistant-1')
    expect(state().expanded['assistant-1']).toBe(true)

    state().toggleExpanded('assistant-1')
    expect(state().expanded['assistant-1']).toBe(false)
  })
})
