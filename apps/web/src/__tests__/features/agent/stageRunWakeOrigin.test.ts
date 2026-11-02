// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentTurnEvent } from '@image-playground/shared'
import { encodeAgentFrame } from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../../features/agent/lib/videoPoster', () => ({
  captureVideoPoster: async () => null,
  blankVideoPoster: () => 'data:image/png;base64,UE9TVEVS',
}))

import {
  isAgentNodeRunOrigin,
  releaseIdleAgentNodeRunOrigins,
} from '../../../features/agent/lib/nodeRuns'
import { useAgentStore } from '../../../features/agent/store'
import { peekCanvasWorkspace } from '../../../features/canvas/lib/activeProject'
import { setClientStorageScope } from '../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

/**
 * 运行回报唤醒的那一轮：开跑上一批的标签页接上它时，轮里新登记的直接出图授权也归这个标签页开跑。
 * 线上复测里素材批跑完、唤醒轮登记了首帧授权，却因为接轮的标签页没有运行权，一个任务都没提交。
 */

const CONVERSATION = 'conversation-wake'
const WAKE_TURN = 'turn-wake'

function turnStream(...events: AgentTurnEvent[]): Response {
  return new Response(events.map((event, at) => encodeAgentFrame(at + 1, event)).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

const frames: AgentTurnEvent[] = [
  { type: 'turnStart', turnId: WAKE_TURN, userMessageId: 'wake-notice' },
  {
    type: 'toolStart',
    messageId: 'tool-frames',
    toolCallId: 'call-frames',
    toolName: 'runStoryboardFrames',
    title: '首帧阶段',
  },
  {
    type: 'toolEnd',
    messageId: 'tool-frames',
    toolCallId: 'call-frames',
    toolName: 'runStoryboardFrames',
    status: 'succeeded',
    title: '首帧阶段',
    canvasRun: {
      projectId: 'project-1',
      nodeIds: ['frame-1', 'frame-2'],
      nodeNames: ['第 1 镜 · 首帧', '第 2 镜 · 首帧'],
      authorizationId: 'auth-frames',
      stage: '首帧',
      estimatedCredits: 200,
      budgetCap: 200,
      status: 'pending',
      direct: true,
    },
  },
  { type: 'turnEnd', turnId: WAKE_TURN, durationMs: 10, stopReason: 'completed', usage: null },
]

let receipts: string[] = []
let history: () => unknown = () => ({
  messages: [],
  activeTurn: { turnId: WAKE_TURN },
  turns: [],
  queue: [],
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  receipts = []
  history = () => ({ messages: [], activeTurn: { turnId: WAKE_TURN }, turns: [], queue: [] })
  releaseIdleAgentNodeRunOrigins()
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/wake')) {
      receipts.push(url)
      return Response.json({ status: 'consumed', turnId: WAKE_TURN })
    }
    if (url.includes('/turns')) return turnStream(...frames)
    if (url.endsWith('/jobs')) return Response.json({ jobs: [] })
    return Response.json(history())
  })
  localStorage.clear()
  setClientStorageScope(crypto.randomUUID())
  peekCanvasWorkspace()
  useAgentStore.setState({
    conversationId: CONVERSATION,
    messages: [],
    turns: {},
    queue: [],
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    historyCached: false,
    historyLoading: false,
    historyFailed: false,
  })
})

afterEach(async () => {
  setClientStorageScope(null)
  useAgentStore.setState({ conversationId: null, messages: [], turn: 'idle', activeTurn: null })
  await vi.advanceTimersByTimeAsync(3_000)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function settles(check: () => void): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      check()
      return
    } catch {
      await vi.advanceTimersByTimeAsync(3_000)
    }
  }
  check()
}

it('本标签页开跑的那批回报之后接上的唤醒轮：轮里的直接出图授权由本标签页开跑', async () => {
  useAgentStore.getState().followStageRunWake(CONVERSATION, 'auth-assets')
  await settles(() =>
    expect(useAgentStore.getState().messages.some((message) => message.id === 'tool-frames')).toBe(
      true,
    ),
  )
  expect(receipts.some((url) => url.includes('/stage-authorizations/auth-assets/wake'))).toBe(true)
  expect(isAgentNodeRunOrigin('tool-frames')).toBe(true)
})

it('普通批次唤醒接上的轮不带运行权：别处登记的直接出图授权不会在这里开跑', async () => {
  useAgentStore.getState().followBatchWake(CONVERSATION, 'batch-1', 1)
  await settles(() =>
    expect(useAgentStore.getState().messages.some((message) => message.id === 'tool-frames')).toBe(
      true,
    ),
  )
  expect(isAgentNodeRunOrigin('tool-frames')).toBe(false)
})

function runCard(id: string, turnId: string, authorizationId: string) {
  const end = frames[2] as Extract<AgentTurnEvent, { type: 'toolEnd' }>
  const { type: _type, messageId: _id, ...block } = end
  return {
    id,
    turnId,
    role: 'assistant' as const,
    createdAt: 1,
    content: [
      {
        ...block,
        type: 'toolResult',
        canvasRun: { ...end.canvasRun!, authorizationId },
      },
    ],
  }
}

it('唤醒轮在接上之前就跑完了：快照里这一轮待确认的阶段授权仍交给本标签页，别的轮不给', async () => {
  history = () => ({
    messages: [
      runCard('older-run', 'turn-older', 'auth-older'),
      runCard('wake-run', WAKE_TURN, 'auth-wake'),
    ],
    activeTurn: null,
    turns: [],
    queue: [],
  })
  useAgentStore.getState().followStageRunWake(CONVERSATION, 'auth-assets')
  await settles(() =>
    expect(useAgentStore.getState().messages.some((message) => message.id === 'wake-run')).toBe(
      true,
    ),
  )
  expect(isAgentNodeRunOrigin('wake-run')).toBe(true)
  expect(isAgentNodeRunOrigin('older-run')).toBe(false)
})
