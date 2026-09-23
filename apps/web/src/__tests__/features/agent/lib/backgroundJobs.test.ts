// @vitest-environment jsdom
import type {
  AgentBackgroundJobProgress,
  AgentBackgroundJobView,
  AgentToolArtifact,
  AgentToolResultBlock,
} from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../../../features/agent/lib/videoPoster', () => ({
  captureVideoPoster: async () => null,
  blankVideoPoster: () => 'data:image/png;base64,UE9TVEVS',
}))

import type { AgentConversationState } from '../../../../features/agent/lib/agentClient'
import { createArtifactDelivery } from '../../../../features/agent/lib/artifactDelivery'
import {
  type AgentJobSession,
  createAgentBackgroundJobs,
} from '../../../../features/agent/lib/backgroundJobs'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import { panelMessage, panelStateFromHistory } from '../../../../features/agent/lib/panelMessages'
import type { AgentRetryRefusal } from '../../../../features/agent/lib/retry'
import type {
  AgentDeliveryStatus,
  AgentPanelMessage,
  AgentToolMessage,
} from '../../../../features/agent/types'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'

const IMAGE: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  taskId: 'task-1',
  outputIndex: 0,
  media: 'image',
  mime: 'image/png',
}

/** 一次提交了后台任务的生成调用，结果块是它此刻的样子。 */
const SUBMITTED: AgentToolResultBlock = {
  type: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  status: 'submitted',
  title: '一只橘猫坐在窗台上',
  snapshot: {
    mode: 'image',
    args: { prompt: '一只橘猫坐在窗台上', n: 1 },
    target: { provider: 'openai-compat', model: 'gpt-image-2' },
  },
  job: { taskId: 'task-1', media: 'image' },
}

/** 同一张失败卡上的一条重试记录，结果落回 `placeholder-9`。 */
const RETRY: Partial<AgentToolResultBlock> = {
  toolCallId: 'retry-call',
  retryOf: { messageId: 'tool-1', toolCallId: 'call-1', placeholderId: 'placeholder-9' },
  job: { taskId: 'task-retry', media: 'image' },
}

function card(result: Partial<AgentToolResultBlock> = {}, id = 'tool-1'): AgentToolMessage {
  const message = panelMessage(id, 'turn-1', 'assistant', [{ ...SUBMITTED, ...result }])
  if (message.kind !== 'tool') throw new Error('not a tool card')
  return message
}

function jobView(result: Partial<AgentToolResultBlock>, id = 'tool-1'): AgentBackgroundJobView {
  return { messageId: id, turnId: 'turn-1', result: { ...SUBMITTED, ...result } }
}

/** 快照里的一条消息。 */
function historyMessage(result: Partial<AgentToolResultBlock>, id = 'tool-1') {
  return {
    id,
    turnId: 'turn-1',
    role: 'assistant' as const,
    content: [{ ...SUBMITTED, ...result }],
    createdAt: 2,
  }
}

function snapshot(
  messages: readonly ReturnType<typeof historyMessage>[],
  activeTurn: { turnId: string } | null = null,
): AgentConversationState {
  return { messages: [...messages], turns: [], activeTurn, queue: [] }
}

/** 用例结束后要关掉的会话：守候循环靠「这个会话还开着」退出。 */
const opened: { conversationId: string | null }[] = []

/** 面板那一侧的假实现：模块只经这些口子读写面板。 */
function fakeSession() {
  const state = {
    conversationId: CONVERSATION as string | null,
    running: false,
    messages: [] as AgentPanelMessage[],
    progress: {} as Record<string, AgentBackgroundJobProgress>,
    refusals: {} as Record<string, AgentRetryRefusal>,
    adopted: [] as { messageIds: string[]; join: string | undefined }[],
  }
  opened.push(state)
  const port: AgentJobSession = {
    messages: () => state.messages,
    isCurrent: (conversationId) => state.conversationId === conversationId,
    isIdle: (conversationId) => state.conversationId === conversationId && !state.running,
    replaceCard: (replacement) => {
      state.messages = state.messages.map((one) => (one.id === replacement.id ? replacement : one))
    },
    appendCards: (cards) => {
      state.messages = [...state.messages, ...cards]
    },
    reportProgress: (messageId, progress) => {
      state.progress[messageId] = progress
    },
    coverRefusal: (placeholderId, refusal) => {
      state.refusals[placeholderId] = refusal
    },
    adopt: async (_conversationId, taken, options) => {
      state.messages = panelStateFromHistory(taken).messages
      state.adopted.push({
        messageIds: state.messages.map((one) => one.id),
        join: options?.join,
      })
    },
  }
  return { state, port }
}

function toolCard(messages: readonly AgentPanelMessage[], id: string): AgentToolMessage {
  const found = messages.find((one) => one.id === id)
  if (found?.kind !== 'tool') throw new Error(`${id} is not on the panel`)
  return found
}

/** 画布那一侧的假实现。 */
const reserved: { count: number; ids: string[] }[] = []
const placedInto: (readonly string[] | undefined)[] = []
const placed: string[] = []
const discarded: string[] = []
const failed: { id: string; code: string | undefined }[] = []
const revived: string[] = []
let placeholderSeq = 0

/** 服务端此刻结算出的任务表。 */
let jobs: () => readonly AgentBackgroundJobView[]
/** 服务端此刻的会话快照。 */
let messages: () => AgentConversationState
/** 取消请求（后台任务与重试各一条路径）此刻的回应。 */
let cancelResponse: (url: string) => Response
let deliveries: Record<string, AgentDeliveryStatus>

/** 这一个模块问过服务端几次：计数按模块算，别的用例漏下的守候数不进来。 */
interface ServerReads {
  jobs: number
  snapshots: number
}

function jobModule(session: AgentJobSession) {
  const delivery = createArtifactDelivery((messageId, status) => {
    deliveries[messageId] = status
  })
  const reads: ServerReads = { jobs: 0, snapshots: 0 }
  return {
    delivery,
    reads,
    jobs: createAgentBackgroundJobs({
      delivery,
      session,
      fetchJobs: async () => {
        reads.jobs += 1
        return jobs()
      },
      fetchSnapshot: async () => {
        reads.snapshots += 1
        return messages()
      },
      timing: { pollIntervalMs: 5, wakePickupDelayMs: 5 },
    }),
  }
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/cancel')) return cancelResponse(url)
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
    }),
  )
  reserved.length = 0
  placedInto.length = 0
  placed.length = 0
  discarded.length = 0
  failed.length = 0
  revived.length = 0
  placeholderSeq = 0
  deliveries = {}
  jobs = () => []
  messages = () => snapshot([])
  cancelResponse = () => Response.json({ error: 'not_found' }, { status: 404 })
  setAgentCanvasSink({
    has: () => false,
    async reserve(request) {
      const ids = Array.from({ length: request.count }, () => `placeholder-${++placeholderSeq}`)
      reserved.push({ count: request.count, ids })
      return ids
    },
    discard(ids) {
      discarded.push(...ids)
    },
    markFailed(ids, _message, code) {
      for (const id of ids) failed.push({ id, code })
    },
    async revive(ids) {
      revived.push(...ids)
    },
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
})

afterEach(() => {
  // 守候循环靠「这个会话还开着」退出：关掉这一个用例开过的会话，别漏进下一个。
  for (const one of opened) one.conversationId = null
  opened.length = 0
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
})

it('轮里提交的任务：本轮占的位移交给它，任务结束时产物落进这个位', async () => {
  const { state, port } = fakeSession()
  const { delivery, jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  let done = false
  jobs = () => [done ? jobView({ status: 'succeeded', artifacts: [IMAGE] }) : jobView({})]

  const turn = delivery.beginTurn()
  turn.reserve(submitted.id, {
    count: 1,
    media: 'image',
    title: '一只橘猫',
    conversationId: CONVERSATION,
  })
  background.track(CONVERSATION, submitted, { kind: 'handOff', turn })
  await turn.settled()

  // 轮已经交还，移交出去的位没被当成僵尸收掉。
  expect(discarded).toEqual([])
  expect(placed).toEqual([])

  done = true
  await vi.waitFor(() => expect(deliveries['tool-1']).toBe('placed'))
  expect(toolCard(state.messages, 'tool-1')).toMatchObject({ status: 'succeeded' })
  expect(placedInto).toEqual([['placeholder-1']])
  expect(placed).toEqual(['agent_image_1'])
  expect(discarded).toEqual([])
})

it('确认草稿当场提交：位在这时候才占，任务失败时就地标错', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({ status: 'failed', message: '上游超时', errorCode: 'timeout' })]

  background.track(CONVERSATION, submitted, { kind: 'reserve' })

  // 拟稿那一步没有占位，位是这一下占的。
  expect(reserved).toEqual([{ count: 1, ids: ['placeholder-1'] }])
  await vi.waitFor(() => expect(failed).toEqual([{ id: 'placeholder-1', code: 'timeout' }]))
  expect(toolCard(state.messages, 'tool-1')).toMatchObject({
    status: 'failed',
    errorCode: 'timeout',
  })
  expect(discarded).toEqual([])
})

it('服务端报的阶段与受理时刻写回面板，阶段随任务推进', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  let stage: 'submitted' | 'running' = 'submitted'
  jobs = () => [{ ...jobView({}), progress: { stage, submittedAt: 1_000 } }]

  background.track(CONVERSATION, submitted, { kind: 'reserve' })

  await vi.waitFor(() =>
    expect(state.progress['tool-1']).toEqual({ stage: 'submitted', submittedAt: 1_000 }),
  )
  stage = 'running'
  await vi.waitFor(() =>
    expect(state.progress['tool-1']).toEqual({ stage: 'running', submittedAt: 1_000 }),
  )
})

it('交出来的已经是终局：当场交付一次，不必等轮询', async () => {
  const { state, port } = fakeSession()
  const { jobs: background, reads } = jobModule(port)
  const done = card({ ...RETRY, status: 'succeeded', artifacts: [IMAGE] }, 'retry-1')
  state.messages = [done]

  background.track(CONVERSATION, done, { kind: 'adopt', placeholderId: 'placeholder-9' })

  await vi.waitFor(() => expect(deliveries['retry-1']).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-9']])
  expect(reads.jobs).toBe(0)
})

it('单张重试：结果落回用户点重试的那个失败占位，不另占新位', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const record = card(RETRY, 'retry-1')
  state.messages = [card({ status: 'failed', errorCode: 'timeout' }), record]
  let done = false
  jobs = () => [
    jobView(done ? { ...RETRY, status: 'succeeded', artifacts: [IMAGE] } : RETRY, 'retry-1'),
  ]

  background.track(CONVERSATION, record, { kind: 'adopt', placeholderId: 'placeholder-9' })

  done = true
  await vi.waitFor(() => expect(deliveries['retry-1']).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-9']])
  expect(reserved).toEqual([])
  expect(toolCard(state.messages, 'tool-1')).toMatchObject({ status: 'failed' })
})

it('排在别的重试后面：占位先不转圈，轮到时才转圈并接住结果', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const queued = card({ ...RETRY, status: 'queued', job: undefined }, 'retry-1')
  state.messages = [queued]
  let phase: 'queued' | 'running' | 'done' = 'queued'
  jobs = () => [
    jobView(
      {
        queued: { ...RETRY, status: 'queued' as const, job: undefined },
        running: RETRY,
        done: { ...RETRY, status: 'succeeded' as const, artifacts: [IMAGE] },
      }[phase],
      'retry-1',
    ),
  ]

  background.track(CONVERSATION, queued, { kind: 'adopt', placeholderId: 'placeholder-9' })

  expect(revived).toEqual([])
  phase = 'running'
  await vi.waitFor(() => expect(toolCard(state.messages, 'retry-1').status).toBe('submitted'))
  expect(revived).toEqual(['placeholder-9'])

  phase = 'done'
  await vi.waitFor(() => expect(deliveries['retry-1']).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-9']])
})

it('别的设备点的重试：面板上没有的记录补在末尾，结束时落回它指的占位', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const origin = card()
  state.messages = [origin]
  let done = false
  jobs = () => [
    jobView({}),
    jobView(done ? { ...RETRY, status: 'succeeded', artifacts: [IMAGE] } : RETRY, 'retry-1'),
  ]

  background.track(CONVERSATION, origin, { kind: 'reserve' })

  await vi.waitFor(() => expect(state.messages.map((one) => one.id)).toEqual(['tool-1', 'retry-1']))
  expect(toolCard(state.messages, 'retry-1')).toMatchObject({
    status: 'submitted',
    retryOf: { messageId: 'tool-1', placeholderId: 'placeholder-9' },
  })

  done = true
  await vi.waitFor(() => expect(deliveries['retry-1']).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-9']])
})

it('会唤醒的任务结束后去挂服务端起的那一轮', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({ status: 'failed', message: '上游超时', errorCode: 'timeout' })]
  messages = () =>
    snapshot([historyMessage({ status: 'failed', message: '上游超时', errorCode: 'timeout' })], {
      turnId: 'turn-wake',
    })

  background.track(CONVERSATION, submitted, { kind: 'reserve' })

  await vi.waitFor(() => expect(state.adopted).toHaveLength(1))
  expect(state.adopted[0]).toMatchObject({ join: 'turn-wake' })
})

it('服务端跳过了唤醒：结果卡记下原因的那份快照换上来', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({ status: 'failed', message: '上游超时', errorCode: 'timeout' })]
  messages = () =>
    snapshot([
      historyMessage({
        status: 'failed',
        message: '上游超时',
        errorCode: 'timeout',
        wakeSkipped: 'insufficient_credits',
      }),
    ])

  background.track(CONVERSATION, submitted, { kind: 'reserve' })

  await vi.waitFor(() => expect(state.adopted).toHaveLength(1))
  expect(state.adopted[0]?.join).toBeUndefined()
  expect(toolCard(state.messages, 'tool-1')).toMatchObject({
    wakeSkipped: 'insufficient_credits',
  })
})

it('成功且没要求复核的任务结束后不去找唤醒轮', async () => {
  const { state, port } = fakeSession()
  const { jobs: background, reads } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({ status: 'succeeded', artifacts: [IMAGE] })]

  background.track(CONVERSATION, submitted, { kind: 'reserve' })

  await vi.waitFor(() => expect(deliveries['tool-1']).toBe('placed'))
  // 唤醒接轮的头一次查看只隔一个宏任务，而落图要等取图那一跑：产物都落下了它还没来，就是不来。
  expect(reads.snapshots).toBe(0)
})

it('单独取消：卡换成取消后的结局，占的位收掉而不是留成失败占位', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({})]
  cancelResponse = () =>
    Response.json({
      job: jobView({ status: 'failed', message: '已中止', errorCode: 'cancelled' }),
    })

  background.track(CONVERSATION, submitted, { kind: 'reserve' })
  await background.cancel(CONVERSATION, 'tool-1')

  expect(toolCard(state.messages, 'tool-1')).toMatchObject({
    status: 'failed',
    errorCode: 'cancelled',
  })
  await vi.waitFor(() => expect(discarded).toEqual(['placeholder-1']))
  expect(failed).toEqual([])
})

it('取消请求失败时卡保持原样，错误交给调用方；换代时占的位照常收掉', async () => {
  const { state, port } = fakeSession()
  const { jobs: background } = jobModule(port)
  const submitted = card()
  state.messages = [submitted]
  jobs = () => [jobView({})]
  cancelResponse = () => Response.json({ error: 'internal' }, { status: 500 })

  background.track(CONVERSATION, submitted, { kind: 'reserve' })
  await expect(background.cancel(CONVERSATION, 'tool-1')).rejects.toThrow()

  expect(toolCard(state.messages, 'tool-1')).toMatchObject({ status: 'submitted' })
  expect(discarded).toEqual([])

  background.reset()
  await vi.waitFor(() => expect(discarded).toEqual(['placeholder-1']))
})

it('换上一段历史之后：已经结算的当场交付，还没结束的接着等', async () => {
  const { state, port } = fakeSession()
  const { jobs: background, reads } = jobModule(port)
  const first = card()
  const second = card({ toolCallId: 'call-2', job: { taskId: 'task-2', media: 'image' } }, 'tool-2')
  state.messages = [first, second]
  jobs = () => [jobView({}, 'tool-2')]
  background.track(CONVERSATION, first, { kind: 'reserve' })
  background.track(CONVERSATION, second, { kind: 'reserve' })
  await vi.waitFor(() => expect(reserved).toHaveLength(2))

  // 快照说第一个已经跑完了：守候的循环没机会看见它，接管这一步必须替它交付。
  state.messages = [card({ status: 'succeeded', artifacts: [IMAGE] }), second]
  background.resume(CONVERSATION, state.messages)

  await vi.waitFor(() => expect(deliveries['tool-1']).toBe('placed'))
  expect(placedInto).toEqual([['placeholder-1']])
  // 还没结束的那个接着问服务端。
  await vi.waitFor(() => expect(reads.jobs).toBeGreaterThan(0))
})
