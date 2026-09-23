// @vitest-environment jsdom
import type {
  AgentToolArtifact,
  AgentToolEndEvent,
  AgentToolResultBlock,
  AgentToolStartEvent,
  AgentTurnEvent,
} from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../../features/agent/lib/videoPoster', () => ({
  captureVideoPoster: async () => null,
  blankVideoPoster: () => 'data:image/png;base64,UE9TVEVS',
}))

import { setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { useAgentStore } from '../../../features/agent/store'
import type { AgentToolMessage } from '../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

/**
 * 快照接管：读回一段历史时，面板与后台任务一起换上它。确认过的卡只往前走，
 * 快照里已经结算的任务当场交付，还没结束的接着等。
 */

const CONVERSATION = 'conversation-1'

function artifact(index: number): AgentToolArtifact {
  return {
    artifactId: `agent_image_${index}`,
    taskId: `task-${index}`,
    outputIndex: 0,
    media: 'image',
    mime: 'image/png',
  }
}

function turnStream(...events: AgentTurnEvent[]): Response {
  return new Response(events.map((event, at) => encodeAgentFrame(at + 1, event)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const TURN_START: AgentTurnEvent = { type: 'turnStart', turnId: 'turn-1', userMessageId: 'user-1' }
const TURN_END: AgentTurnEvent = {
  type: 'turnEnd',
  turnId: 'turn-1',
  durationMs: 10,
  stopReason: 'completed',
  usage: null,
}

function toolStart(index: number): AgentToolStartEvent {
  return {
    type: 'toolStart',
    messageId: `tool-${index}`,
    toolCallId: `call-${index}`,
    toolName: 'generateImage',
    title: `第 ${index} 张`,
    outputCount: 1,
  }
}

function toolEnd(index: number): AgentToolEndEvent {
  return {
    type: 'toolEnd',
    messageId: `tool-${index}`,
    toolCallId: `call-${index}`,
    toolName: 'generateImage',
    status: 'submitted',
    title: `第 ${index} 张`,
    job: { taskId: `task-${index}`, media: 'image' },
  }
}

function resultBlock(index: number, patch: Partial<AgentToolResultBlock>): AgentToolResultBlock {
  const { type: _type, messageId: _id, ...base } = toolEnd(index)
  return { ...base, type: 'toolResult', ...patch }
}

function historyMessage(id: string, content: unknown[], createdAt: number) {
  return { id, turnId: 'turn-1', role: 'assistant' as const, content, createdAt }
}

let turnResponse: () => Response
let abortResponse: () => Response
let messagesResponse: () => Response
let jobsResponse: () => unknown[]

const reserved: string[][] = []
const placedInto: (readonly string[] | undefined)[] = []
const placed: string[] = []
let placeholderSeq = 0

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/abort')) return abortResponse()
  if (url.includes('/turns')) return turnResponse()
  if (url.endsWith('/jobs')) return Response.json({ jobs: jobsResponse() })
  if (url.includes('/v1/queue/requests/'))
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  if (init?.method === 'POST' && url.endsWith('/api/agent/conversations'))
    return Response.json({
      conversation: { id: CONVERSATION, title: '', createdAt: 1, updatedAt: 1 },
    })
  return messagesResponse()
})

function state() {
  return useAgentStore.getState()
}

function toolCard(id: string): AgentToolMessage {
  const found = state().messages.find((one) => one.id === id)
  if (found?.kind !== 'tool') throw new Error(`${id} is not on the panel`)
  return found
}

/** 后台任务守候问服务端的真实间隔；假时钟每次就推过这么一整跳。 */
const JOB_POLL_MS = 3_000

/**
 * 等一件事成立。守候与唤醒接轮都是隔几秒问一次服务端，假时钟自己不会走：没成立就把时钟
 * 推过一整跳，推的过程里这一跳带出来的请求与交付也一并跑完，再看一次。
 */
async function settles(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      check()
      return
    } catch {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
    }
  }
  check()
}

beforeEach(() => {
  // 守候与唤醒接轮按真实节奏隔几秒问一次：用假时钟把那几跳推过去，不去改模块的构造参数。
  // 只假掉模块用的那一个定时器：fake-indexeddb 与 fetch 的内部还靠 setImmediate 推进。
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  reserved.length = 0
  placedInto.length = 0
  placed.length = 0
  placeholderSeq = 0
  turnResponse = () => turnStream(TURN_START, TURN_END)
  abortResponse = () => Response.json({ aborted: true })
  messagesResponse = () => Response.json({ messages: [], activeTurn: null, turns: [], queue: [] })
  jobsResponse = () => []
  setAgentCanvasSink({
    has: () => false,
    async reserve(request) {
      const ids = Array.from({ length: request.count }, () => `placeholder-${++placeholderSeq}`)
      reserved.push(ids)
      return ids
    },
    discard() {},
    markFailed() {},
    async place(items, options) {
      placedInto.push(options?.placeholderIds)
      for (const item of items) placed.push(item.artifactId)
      return 'placed'
    },
    focus() {},
    async thumbnail() {
      return null
    },
  })
  useAgentStore.setState({
    conversationId: null,
    messages: [],
    turns: {},
    queue: [],
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    loaded: false,
    jobProgress: {},
    toolStartedAt: {},
    retryRefusals: {},
    promptDrafts: {},
  })
})

afterEach(async () => {
  useAgentStore.setState({ conversationId: null, messages: [], turn: 'idle', activeTurn: null })
  // 守候按会话退出，但要等到下一跳才看得见会话已经切走：先推过那一跳再收假时钟，否则它带着
  // 上一个会话停在半路，下一个用例的守候会被当成同一次而不再开。
  await vi.advanceTimersByTimeAsync(JOB_POLL_MS)
  vi.useRealTimers()
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

it('停止撞上 404 后按历史重来：刚确认过的那张卡不退回草稿', async () => {
  const confirmed: AgentToolMessage = {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    title: '第 1 张',
    prompt: '一只橘猫',
    status: 'submitted',
    job: { taskId: 'task-1', media: 'image' },
  }
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [confirmed],
    turn: 'running',
    activeTurn: { turnId: 'turn-1' },
  })
  // 轮恰好在停止请求到达之前结束了，服务端答 404；而这一刻读回的历史还没写上那次确认。
  abortResponse = () => Response.json({ error: 'turn_not_found' }, { status: 404 })
  messagesResponse = () =>
    Response.json({
      activeTurn: null,
      turns: [],
      queue: [],
      messages: [
        historyMessage(
          'tool-1',
          [
            {
              type: 'toolResult',
              toolCallId: 'call-1',
              toolName: 'generateImage',
              status: 'awaiting_confirmation',
              title: '第 1 张',
              prompt: '一只橘猫',
            },
          ],
          2,
        ),
      ],
    })

  await state().abort()

  expect(state().turn).toBe('idle')
  expect(state().error).toBeNull()
  // 确认过的那次生成只往前走：盖回草稿就再没人等这个后台任务，卡上还会谎称什么都没生成。
  expect(toolCard('tool-1')).toMatchObject({
    status: 'submitted',
    job: { taskId: 'task-1' },
  })
})

it('唤醒接轮换上快照时：已经结算的任务当场交付，还没结束的接着等', async () => {
  turnResponse = () =>
    turnStream(
      TURN_START,
      toolStart(1),
      toolEnd(1),
      toolStart(2),
      toolEnd(2),
      toolStart(3),
      toolEnd(3),
      TURN_END,
    )
  // 第一个任务失败了（会唤醒智能体），另外两个这时还在跑。
  let settledUpstream = false
  jobsResponse = () => [
    {
      messageId: 'tool-1',
      turnId: 'turn-1',
      result: resultBlock(1, { status: 'failed', message: '上游超时', errorCode: 'timeout' }),
    },
    {
      messageId: 'tool-2',
      turnId: 'turn-1',
      result: resultBlock(
        2,
        settledUpstream ? { status: 'succeeded', artifacts: [artifact(2)] } : {},
      ),
    },
    {
      messageId: 'tool-3',
      turnId: 'turn-1',
      result: resultBlock(
        3,
        settledUpstream ? { status: 'succeeded', artifacts: [artifact(3)] } : {},
      ),
    },
  ]
  // 去找唤醒轮时读到的快照：服务端那一轮已经跑完，第二个任务也在这中间结算了，第三个还在跑。
  messagesResponse = () =>
    Response.json({
      activeTurn: null,
      turns: [],
      queue: [],
      messages: [
        historyMessage('tool-1', [resultBlock(1, { status: 'failed', errorCode: 'timeout' })], 2),
        historyMessage(
          'tool-2',
          [resultBlock(2, { status: 'succeeded', artifacts: [artifact(2)] })],
          3,
        ),
        historyMessage('tool-3', [resultBlock(3, {})], 4),
        {
          id: 'wake-reply',
          turnId: 'turn-wake',
          role: 'assistant',
          content: [{ type: 'text', text: '第一张没出来，要换个说法再试吗？' }],
          createdAt: 5,
        },
      ],
    })

  await state().send('画三只猫')
  expect(reserved).toEqual([['placeholder-1'], ['placeholder-2'], ['placeholder-3']])

  // 快照接管的那一下必须替它交付：轮询只认没结束的卡，错过这一次，占的位会一直转圈。
  await settles(() => expect(toolCard('tool-2').delivery).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-2']])
  expect(placed).toEqual(['agent_image_2'])

  // 快照里还没结束的那个照旧接着问服务端。
  settledUpstream = true
  await settles(() => expect(toolCard('tool-3').delivery).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-2'], ['placeholder-3']])
})
