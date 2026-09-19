// @vitest-environment jsdom
import type {
  AgentBackgroundJobView,
  AgentMessageView,
  AgentToolArtifact,
  AgentToolResultBlock,
} from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// 顶栏余额的刷新信号：确认那一刻服务端已经预扣，界面必须跟着刷新。
vi.mock('../../../lib/privateOverlay', () => ({
  notifyPrivateSubmissionSettled: vi.fn(),
  notifyPrivateSubmissionError: vi.fn(),
  PrivateWebOverlayPresent: false,
}))

import { setAgentCanvasSink } from '../../../features/agent/lib/canvasSink'
import { setAgentJobPollIntervalForTesting, useAgentStore } from '../../../features/agent/store'
import type { AgentToolMessage } from '../../../features/agent/types'
import { notifyPrivateSubmissionSettled } from '../../../lib/privateOverlay'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const CONVERSATION = 'conversation-1'
const OTHER = 'conversation-2'

const IMAGE: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  media: 'image',
  taskId: 'task-1',
  outputIndex: 0,
  mime: 'image/png',
}

const DRAFTED = '把白色浴缸换成浅灰绿色浴缸，保留原有瓷砖与光线。'
const CORRECTED = '把浴缸换成白色浴缸，不要改变颜色，保留原有瓷砖与光线。'

const drafted: AgentToolResultBlock = {
  type: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  status: 'awaiting_confirmation',
  title: '换一只浴缸',
  prompt: DRAFTED,
  snapshot: { mode: 'image', args: { n: 2 }, target: { provider: 'openai', model: 'gpt-image-1' } },
}

const draftMessage: AgentMessageView = {
  id: 'tool-1',
  turnId: 'turn-1',
  role: 'assistant',
  createdAt: 1,
  content: [drafted],
}

const confirmed: AgentMessageView = {
  id: 'tool-1',
  turnId: 'turn-1',
  role: 'assistant',
  createdAt: 2,
  content: [
    {
      ...drafted,
      status: 'submitted',
      prompt: CORRECTED,
      job: { taskId: 'task-1', media: 'image' },
    },
  ],
}

const finishedJob: AgentBackgroundJobView = {
  messageId: 'tool-1',
  turnId: 'turn-1',
  result: {
    ...drafted,
    status: 'succeeded',
    prompt: CORRECTED,
    job: { taskId: 'task-1', media: 'image' },
    artifacts: [IMAGE],
  },
}

const posted: unknown[] = []
let confirmResponse: () => Response | Promise<Response>
let jobsResponse: () => readonly AgentBackgroundJobView[]
let history: (conversationId: string) => readonly AgentMessageView[]

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.endsWith('/confirmations')) {
    posted.push(JSON.parse(String(init?.body ?? 'null')))
    return confirmResponse()
  }
  if (url.endsWith('/jobs')) return Response.json({ jobs: jobsResponse() })
  if (url.includes('/v1/queue/requests/'))
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
  const conversationId = url.includes(OTHER) ? OTHER : CONVERSATION
  return Response.json({ messages: history(conversationId), activeTurn: null, turns: [] })
})

const reserved: { count: number; media?: string; ids: string[] }[] = []
const placed: { artifactId: string }[] = []
const placedInto: (readonly string[] | undefined)[] = []
const onCanvas = new Set<string>()
let placeholderSeq = 0

function state() {
  return useAgentStore.getState()
}

function toolCard(): AgentToolMessage {
  const message = state().messages.find((one) => one.kind === 'tool')
  if (message?.kind !== 'tool') throw new Error('expected a tool card')
  return message
}

const jobRequests = () =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/jobs')).length

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  posted.length = 0
  reserved.length = 0
  placed.length = 0
  placedInto.length = 0
  onCanvas.clear()
  placeholderSeq = 0
  vi.mocked(notifyPrivateSubmissionSettled).mockClear()
  confirmResponse = () => Response.json({ message: confirmed })
  jobsResponse = () => []
  history = (conversationId) => (conversationId === CONVERSATION ? [draftMessage] : [])
  setAgentJobPollIntervalForTesting(5)
  setAgentCanvasSink({
    has: (objectId) => onCanvas.has(objectId),
    async reserve(request) {
      const ids = Array.from(
        { length: request.count },
        () => `placeholder-${(placeholderSeq += 1)}`,
      )
      reserved.push({ count: request.count, media: request.media, ids })
      return ids
    },
    discard() {},
    markFailed() {},
    async place(items, options) {
      placedInto.push(options?.placeholderIds)
      for (const item of items) {
        placed.push({ artifactId: item.artifactId })
        onCanvas.add(item.artifactId)
      }
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
    promptDrafts: {},
    turns: {},
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: false,
    jobProgress: {},
    toolStartedAt: {},
  })
})

afterEach(() => {
  useAgentStore.setState({ conversationId: null, messages: [] })
  setAgentJobPollIntervalForTesting()
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

it('读回历史里的草稿卡：不占画布的位，也不去等任何后台任务', async () => {
  await state().selectConversation(CONVERSATION)

  expect(toolCard()).toMatchObject({ status: 'awaiting_confirmation', prompt: DRAFTED })
  expect(reserved).toEqual([])
  expect(jobRequests()).toBe(0)
})

it('确认之后才按快照占位、才开始等结果，产物落进占好的位', async () => {
  await state().selectConversation(CONVERSATION)
  jobsResponse = () => [finishedJob]

  expect(await state().confirmPrompt('tool-1', CORRECTED)).toEqual({ ok: true })

  expect(posted).toEqual([{ deviceId: expect.any(String), messageId: 'tool-1', prompt: CORRECTED }])
  // 服务端就地改写同一条：卡换成已提交，提示词是用户确认的那一份。
  expect(state().messages).toHaveLength(1)
  expect(toolCard()).toMatchObject({ id: 'tool-1', status: 'submitted', prompt: CORRECTED })
  expect(reserved).toEqual([{ count: 2, media: 'image', ids: ['placeholder-1', 'placeholder-2'] }])

  await vi.waitFor(() => expect(toolCard().delivery).toBe('placed'))
  expect(toolCard().status).toBe('succeeded')
  expect(placed).toEqual([{ artifactId: 'agent_image_1' }])
  expect(placedInto).toEqual([['placeholder-1', 'placeholder-2']])
})

it('重复确认（双击、另一个标签页）只占一次位、只等一个任务', async () => {
  await state().selectConversation(CONVERSATION)

  await Promise.all([
    state().confirmPrompt('tool-1', CORRECTED),
    state().confirmPrompt('tool-1', CORRECTED),
  ])

  expect(reserved).toHaveLength(1)
  expect(state().messages).toHaveLength(1)
})

it('确认的响应回来时已经切走：不把这次生成塞进新项目，余额照样刷新', async () => {
  await state().selectConversation(CONVERSATION)
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  confirmResponse = async () => {
    await held
    return Response.json({ message: confirmed })
  }

  const pending = state().confirmPrompt('tool-1', CORRECTED)
  await state().selectConversation(OTHER)
  vi.mocked(notifyPrivateSubmissionSettled).mockClear()
  release()
  expect(await pending).toEqual({ ok: true })

  expect(state().conversationId).toBe(OTHER)
  expect(state().messages).toEqual([])
  expect(reserved).toEqual([])
  // 预扣属于用户而不属于某个项目：切走了，顶栏余额与提交门禁还是要跟着刷新。
  expect(notifyPrivateSubmissionSettled).toHaveBeenCalled()
})

it('重复确认回来的已经是终局：产物落进第一次占好的位，不留空转的框', async () => {
  await state().selectConversation(CONVERSATION)
  expect(await state().confirmPrompt('tool-1', CORRECTED)).toEqual({ ok: true })
  expect(reserved).toHaveLength(1)

  // 组件重挂后又点了一次，这一次服务端给回的是已经跑完的那张卡（轮询还没问到）。
  confirmResponse = () =>
    Response.json({ message: { ...confirmed, content: [finishedJob.result] } })
  expect(await state().confirmPrompt('tool-1', CORRECTED)).toEqual({ ok: true })

  await vi.waitFor(() => expect(toolCard().delivery).toBe('placed'))
  expect(toolCard().status).toBe('succeeded')
  expect(placedInto).toEqual([['placeholder-1', 'placeholder-2']])
  expect(reserved).toHaveLength(1)
})

it('确认之后重读历史：慢一步的草稿不把已提交的卡拉回拟稿', async () => {
  await state().selectConversation(CONVERSATION)
  expect(await state().confirmPrompt('tool-1', CORRECTED)).toEqual({ ok: true })

  // 服务端还没把改写后的消息读出来（或者活跃轮的快照仍停在拟稿那一刻）。
  await state().retryHistory()

  expect(toolCard()).toMatchObject({ status: 'submitted', prompt: CORRECTED })
  jobsResponse = () => [finishedJob]
  await vi.waitFor(() => expect(toolCard().status).toBe('succeeded'))
})
