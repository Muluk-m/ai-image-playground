// @vitest-environment jsdom
import type { AgentConversationView, AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PANEL_WIDTH } from '../../../features/agent/agentStyles'
import {
  agentActivityPhase,
  answerableClarificationId,
  useAgentStore,
} from '../../../features/agent/store'
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

let turnResponse: () => Response | Promise<Response>
let messagesResponse: () => Response
let conversationsResponse: () => Response
let deleteResponse: () => Response

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/api/agent/conversations') && init?.method === 'POST') {
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  }
  if (init?.method === 'DELETE') return deleteResponse()
  if (url.endsWith('/api/agent/conversations')) return conversationsResponse()
  if (url.includes('/turns')) return turnResponse()
  return messagesResponse()
})

function conversation(id: string, title: string): AgentConversationView {
  return { id, title, createdAt: 1, updatedAt: 1 }
}

function state() {
  return useAgentStore.getState()
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  turnResponse = () => turnStream(TURN_START)
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
  conversationsResponse = () => Response.json({ conversations: [] })
  deleteResponse = () => Response.json({ ok: true })
  useAgentStore.setState({
    conversationId: null,
    conversations: [],
    messages: [],
    turn: 'idle',
    activeTurn: null,
    turns: {},
    error: null,
    loaded: false,
    historyLoading: false,
    historyFailed: false,
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
        text: '好的，我把背景换成浅木色',
        streaming: false,
      },
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
        usage: null,
      })

    await state().send('把背景换成浅木色')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('这一轮没有跑完')
    expect(state().messages.map((message) => message.kind === 'text' && message.role)).toEqual([
      'user',
    ])
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
        turns: [],
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
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '第一句',
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
  })

  it('会话已经不在时忘掉它', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => new Response('{}', { status: 404 })

    await state().load()

    expect(state().conversationId).toBeNull()
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBeNull()
  })

  it('身份对不上时也忘掉它', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => new Response('{}', { status: 403 })

    await state().load()

    expect(state().conversationId).toBeNull()
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBeNull()
  })

  it('读不回来但会话还在时留着它并报错', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => new Response('{}', { status: 400 })

    await state().load()

    expect(state().conversationId).toBe(CONVERSATION)
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBe(CONVERSATION)
    expect(state().error).toBe('对话暂时未能加载，请重新加载。')
  })

  it('网络断了同样留着会话', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => {
      throw new TypeError('Failed to fetch')
    }

    await state().load()

    expect(state().conversationId).toBe(CONVERSATION)
    expect(state().error).toBe('对话暂时未能加载，请重新加载。')
  })
})

describe('发送反馈', () => {
  it('敲下回车消息立刻上屏，turnStart 到了换成服务端的 id', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    turnResponse = async () => {
      await gate
      return turnStream(TURN_START, TURN_END)
    }

    const sending = state().send('把背景换成浅木色')
    await Promise.resolve()
    expect(state().turn).toBe('running')
    expect(state().activeTurn).toBeNull()
    expect(agentActivityPhase(state())).toBe('sending')
    const pending = state().messages.filter((one) => one.kind === 'text' && one.pending)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ role: 'user', text: '把背景换成浅木色' })

    release()
    await sending
    expect(state().messages.map((one) => one.id)).toEqual(['user-1'])
    expect(state().messages.some((one) => one.kind === 'text' && one.pending)).toBe(false)
  })

  it('状态相位：起轮前发送中，等模型时思考中，工具跑着执行中，文字在流就让位', () => {
    const user = {
      kind: 'text' as const,
      id: 'user-1',
      turnId: 'turn-1',
      role: 'user' as const,
      text: '画',
      streaming: false,
    }
    expect(agentActivityPhase({ turn: 'idle', activeTurn: null, messages: [user] })).toBeNull()
    expect(agentActivityPhase({ turn: 'running', activeTurn: null, messages: [user] })).toBe(
      'sending',
    )
    const active = { turnId: 'turn-1' }
    expect(agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user] })).toBe(
      'thinking',
    )
    const tool = {
      kind: 'tool' as const,
      id: 'tool-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      title: '生成图片',
      status: 'running' as const,
    }
    expect(
      agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user, tool] }),
    ).toBe('executing')
    const reply = { ...user, id: 'assistant-1', role: 'assistant' as const, streaming: true }
    expect(
      agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user, reply] }),
    ).toBeNull()
    expect(
      agentActivityPhase({
        turn: 'running',
        activeTurn: active,
        messages: [user, { ...reply, text: '' }],
      }),
    ).toBe('thinking')
  })
})

describe('面板宽度', () => {
  it('拖过的宽度夹在最窄与视口六成之间并记进 localStorage', () => {
    vi.stubGlobal('innerWidth', 1000)
    state().setPanelWidth(100)
    expect(state().panelWidth).toBe(PANEL_WIDTH)
    state().setPanelWidth(5000)
    expect(state().panelWidth).toBe(600)
    state().setPanelWidth(420.4)
    expect(state().panelWidth).toBe(420)
    expect(localStorage.getItem('image-playground.agent_panel_width')).toBe('420')
  })
})

describe('会话列表', () => {
  it('读回当前身份名下的会话', async () => {
    conversationsResponse = () =>
      Response.json({
        conversations: [conversation('c-2', '第二件事'), conversation('c-1', '第一件事')],
      })

    await state().load()

    expect(state().conversations.map((one) => one.title)).toEqual(['第二件事', '第一件事'])
  })

  it('切到另一个会话时读它的消息并记住它', async () => {
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'user-9',
            turnId: 'turn-9',
            role: 'user',
            content: [{ type: 'text', text: '上周那套图' }],
            createdAt: 1,
          },
        ],
      })

    await state().selectConversation('c-2')

    expect(state().conversationId).toBe('c-2')
    expect(state().messages.map((message) => message.kind === 'text' && message.text)).toEqual([
      '上周那套图',
    ])
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBe('c-2')
  })

  it('删掉当前会话后回到空白的新会话', async () => {
    useAgentStore.setState({
      conversationId: 'c-1',
      conversations: [conversation('c-1', '试错的一轮'), conversation('c-2', '留着的')],
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '试试',
          streaming: false,
        },
      ],
    })
    localStorage.setItem('image-playground.agent_conversation_id', 'c-1')

    await state().deleteConversation('c-1')

    expect(state().conversations.map((one) => one.id)).toEqual(['c-2'])
    expect(state().conversationId).toBeNull()
    expect(state().messages).toEqual([])
    expect(localStorage.getItem('image-playground.agent_conversation_id')).toBeNull()
  })

  it('删掉别的会话不动当前这个', async () => {
    useAgentStore.setState({
      conversationId: 'c-1',
      conversations: [conversation('c-1', '当前'), conversation('c-2', '另一个')],
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '试试',
          streaming: false,
        },
      ],
    })

    await state().deleteConversation('c-2')

    expect(state().conversations.map((one) => one.id)).toEqual(['c-1'])
    expect(state().conversationId).toBe('c-1')
    expect(state().messages).toHaveLength(1)
  })

  it('第二轮之后不再重拉列表', async () => {
    turnResponse = () => turnStream(TURN_START, TURN_END)
    await state().send('第一句')
    const afterFirst = fetchMock.mock.calls.length

    await state().send('第二句')

    const listCalls = fetchMock.mock.calls
      .slice(afterFirst)
      .filter(([input]) => String(input).endsWith('/api/agent/conversations'))
    expect(listCalls).toEqual([])
  })

  it('开新会话只清空当前，不建空会话', async () => {
    useAgentStore.setState({
      conversationId: 'c-1',
      messages: [
        {
          kind: 'text',
          id: 'user-1',
          turnId: 'turn-1',
          role: 'user',
          text: '试试',
          streaming: false,
        },
      ],
    })
    localStorage.setItem('image-playground.agent_conversation_id', 'c-1')

    state().startNewConversation()

    expect(state().conversationId).toBeNull()
    expect(state().messages).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('限流', () => {
  it('被拦下时给一句可读提示', async () => {
    turnResponse = () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 })

    await state().send('再来一张')

    expect(state().turn).toBe('failed')
    expect(state().error).toBe('发送太频繁，稍后再试')
  })
})

describe('澄清', () => {
  const CLARIFICATION: AgentTurnEvent = {
    type: 'clarification',
    messageId: 'clarify-1',
    question: '要哪种风格？',
    options: ['写实照片', '扁平插画'],
  }

  const CARD = {
    kind: 'clarification',
    id: 'clarify-1',
    turnId: 'turn-1',
    question: '要哪种风格？',
    options: ['写实照片', '扁平插画'],
  }

  it('这一轮以单选收尾，用户选的那一项开启下一轮', async () => {
    turnResponse = () => turnStream(TURN_START, CLARIFICATION, TURN_END)

    await state().send('给我画个杯子')

    expect(state().turn).toBe('idle')
    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '给我画个杯子',
        streaming: false,
      },
      CARD,
    ])
    expect(answerableClarificationId(state().messages)).toBe('clarify-1')

    turnResponse = () =>
      turnStream(
        { type: 'turnStart', turnId: 'turn-2', userMessageId: 'user-2' },
        { type: 'assistantStart', messageId: 'assistant-2' },
        { type: 'textDelta', messageId: 'assistant-2', delta: '好的' },
        { type: 'turnEnd', turnId: 'turn-2', durationMs: 5, stopReason: 'completed', usage: null },
      )

    await state().send('写实照片')

    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '给我画个杯子',
        streaming: false,
      },
      CARD,
      {
        kind: 'text',
        id: 'user-2',
        turnId: 'turn-2',
        role: 'user',
        text: '写实照片',
        streaming: false,
      },
      {
        kind: 'text',
        id: 'assistant-2',
        turnId: 'turn-2',
        role: 'assistant',
        text: '好的',
        streaming: false,
      },
    ])
    // 后面已经有用户消息了，这条澄清作过答。
    expect(answerableClarificationId(state().messages)).toBeNull()
  })

  it('重新打开会话时没作答的澄清还能作答', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () =>
      Response.json({
        activeTurn: null,
        turns: [],
        messages: [
          {
            id: 'user-1',
            turnId: 'turn-1',
            role: 'user',
            content: [{ type: 'text', text: '给我画个杯子' }],
            createdAt: 1,
          },
          {
            id: 'clarify-1',
            turnId: 'turn-1',
            role: 'assistant',
            content: [
              {
                type: 'clarification',
                question: '要哪种风格？',
                options: ['写实照片', '扁平插画'],
              },
            ],
            createdAt: 2,
          },
        ],
      })

    await state().load()

    expect(state().messages).toEqual([
      {
        kind: 'text',
        id: 'user-1',
        turnId: 'turn-1',
        role: 'user',
        text: '给我画个杯子',
        streaming: false,
      },
      CARD,
    ])
    expect(answerableClarificationId(state().messages)).toBe('clarify-1')
  })
})

describe('发送确认', () => {
  it('插话携带引用，拒收时不清草稿也不结束正在运行的轮', async () => {
    useAgentStore.setState({
      conversationId: CONVERSATION,
      turn: 'running',
      activeTurn: { turnId: 'turn-1' },
    })
    turnResponse = () => new Response(null, { status: 409 })
    const accepted = vi.fn()
    const references = [{ imageId: 'new-image', dataUrl: 'data:image/png;base64,aGk=' }]
    await state().send('修改这张', references, accepted)
    expect(accepted).not.toHaveBeenCalled()
    expect(state().turn).toBe('running')
    expect(state().error).toContain('草稿已保留')
    const request = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!
    expect(JSON.parse(String(request[1]?.body)).references).toEqual(references)
    turnResponse = () => Response.json({ messageId: 'user-2' })
    await state().send('修改这张', references, accepted)
    expect(accepted).toHaveBeenCalledOnce()
  })
  it('起轮失败时不确认发送，成功响应后才确认', async () => {
    turnResponse = () => new Response(null, { status: 429 })
    const accepted = vi.fn()
    await state().send('画一只猫', [], accepted)
    expect(accepted).not.toHaveBeenCalled()
    turnResponse = () => turnStream(TURN_START, TURN_END)
    await state().send('画一只猫', [], accepted)
    expect(accepted).toHaveBeenCalledOnce()
  })
})

describe('历史读取重试', () => {
  it('失败后仅重读当前会话，期间禁止发送，不新建会话或发起轮', async () => {
    localStorage.setItem('image-playground.agent_conversation_id', CONVERSATION)
    messagesResponse = () => new Response('{}', { status: 503 })
    await state().load()
    expect(state().historyFailed).toBe(true)
    expect(state().conversationId).toBe(CONVERSATION)
    const calls = fetchMock.mock.calls.length
    await state().send('草稿不能误发')
    expect(fetchMock).toHaveBeenCalledTimes(calls)
    messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [] })
    await state().retryHistory()
    expect(state().historyFailed).toBe(false)
    expect(state().historyLoading).toBe(false)
    expect(state().error).toBeNull()
    expect(state().conversationId).toBe(CONVERSATION)
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })
})
