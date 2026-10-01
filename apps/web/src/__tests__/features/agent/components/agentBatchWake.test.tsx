// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  type AgentBatchPage,
  type AgentTurnEvent,
  encodeAgentFrame,
} from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { panelMessage } from '../../../../features/agent/lib/panelMessages'
import { useAgentStore } from '../../../../features/agent/store'
import { setClientStorageScope } from '../../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Conversation() {
  const messages = useAgentStore((state) => state.messages)
  return messages.map((message) =>
    message.kind === 'tool' ? (
      <AgentToolCard key={message.id} message={message} />
    ) : message.kind === 'text' ? (
      <p key={message.id}>{message.text}</p>
    ) : null,
  )
}

it.each([
  'stream',
  'history',
  'navigation',
] as const)('adopts a completed batch wake without resubmission (%s)', async (mode) => {
  vi.useFakeTimers()
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  setClientStorageScope(`batch-wake-${crypto.randomUUID()}`)
  const batchId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const plan = {
    id: 'original-plan',
    turnId: 'original-turn',
    role: 'assistant' as const,
    createdAt: 1,
    content: [
      {
        type: 'toolResult' as const,
        toolName: 'planImageBatch' as const,
        toolCallId: 'plan-call',
        title: '检查商品',
        status: 'succeeded' as const,
        batchId,
      },
    ],
  }
  const reply = {
    id: 'wake-summary',
    turnId: 'wake-turn',
    role: 'assistant' as const,
    createdAt: 2,
    content: [{ type: 'text' as const, text: '全部检查完成，请确认下一阶段。' }],
  }
  const proposal = {
    id: 'next-phase',
    turnId: 'wake-turn',
    role: 'assistant' as const,
    createdAt: 3,
    content: [
      {
        type: 'toolResult' as const,
        toolName: 'proposeBatchGeneration' as const,
        toolCallId: 'proposal-call',
        title: '生成下一阶段',
        status: 'succeeded' as const,
        batchId,
      },
    ],
  }
  const quote = {
    status: 'available' as const,
    estimatedCredits: 0,
    estimatedChargeCredits: 0,
    snapshots: [],
  }
  let page: AgentBatchPage = {
    batch: {
      id: batchId,
      conversationId,
      originTurnId: 'original-turn',
      experience: 'chat',
      projectId: null,
      targetSnapshot: { projectId: null, projectRevision: null },
      version: 1,
      digest: 'a'.repeat(64),
      title: '检查商品',
      rule: '检查',
      itemCount: 1,
      status: 'running',
      executionEnabled: true,
      submittedCount: 1,
      actualCredits: 0,
      createdAt: 1,
      estimate: { analysis: quote, generation: quote },
    },
    items: [
      {
        kind: 'generation',
        key: 'one',
        ordinal: 0,
        inputs: [],
        prompt: '检查',
        params: { model: 'test-model', provider: 'openai-compat' },
        dependencies: [],
        execution: { taskId: 'task-one', status: 'in_progress', attempt: 1, actualCredits: null },
      },
    ],
    nextCursor: null,
  }
  let batchReads = 0
  let snapshots = 0
  let streams = 0
  const methods: string[] = []
  let releaseSnapshot!: () => void
  const barrier = new Promise<void>((resolve) => {
    releaseSnapshot = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    methods.push(init?.method ?? 'GET')
    if (url.includes(`/api/agent/batches/${batchId}`)) {
      batchReads++
      return Response.json(page)
    }
    if (url.endsWith(`/conversations/${conversationId}/messages`)) {
      snapshots++
      if (mode === 'navigation') await barrier
      return Response.json({
        activeTurn: mode === 'stream' && snapshots > 1 ? { turnId: 'wake-turn' } : null,
        messages: mode !== 'stream' && snapshots > 1 ? [plan, reply, proposal] : [plan],
        turns: [],
        queue: [],
      })
    }
    if (url.includes('/turns/wake-turn/events')) {
      streams++
      const events: AgentTurnEvent[] = [
        { type: 'turnStart', turnId: 'wake-turn', userMessageId: 'wake-turn:wake', wake: true },
        { type: 'assistantStart', messageId: reply.id },
        { type: 'textDelta', messageId: reply.id, delta: reply.content[0]!.text },
        {
          type: 'toolStart',
          messageId: proposal.id,
          toolName: 'proposeBatchGeneration',
          toolCallId: 'proposal-call',
          title: '生成下一阶段',
        },
        {
          type: 'toolEnd',
          messageId: proposal.id,
          toolName: 'proposeBatchGeneration',
          toolCallId: 'proposal-call',
          title: '生成下一阶段',
          status: 'succeeded',
          batchId,
        },
        {
          type: 'turnEnd',
          turnId: 'wake-turn',
          durationMs: 1,
          stopReason: 'completed',
          usage: null,
        },
      ]
      return new Response(
        events.map((event, index) => encodeAgentFrame(index + 1, event)).join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  useAgentStore.setState({
    conversationId,
    messages: [panelMessage(plan.id, plan.turnId, plan.role, plan.content)],
    turns: {},
    queue: [],
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: true,
  })
  try {
    await act(async () => root.render(<Conversation />))
    // The card waits for its real IndexedDB command receipt before installing the poll.
    await vi.waitFor(() => expect(host.querySelectorAll('details')).toHaveLength(1))
    expect(batchReads).toBe(1)
    page = {
      ...page,
      batch: { ...page.batch, status: 'closed' },
      items: page.items.map((item) => ({
        ...item,
        execution: { taskId: 'task-one', status: 'completed', attempt: 1, actualCredits: 0 },
      })),
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_100)
    })
    // Flush the completion effect's first scheduled wake lookup after React commits the page.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(batchReads).toBeGreaterThan(1)
    expect(snapshots).toBeGreaterThan(0)
    if (mode === 'navigation') {
      act(() => useAgentStore.getState().startNewConversation())
      releaseSnapshot()
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    if (mode === 'navigation') {
      expect(useAgentStore.getState().conversationId).toBeNull()
      expect(host.textContent).not.toContain(reply.content[0]!.text)
      expect(streams).toBe(0)
    } else {
      expect(host.textContent).toContain(reply.content[0]!.text)
      expect(
        useAgentStore.getState().messages.filter((one) => one.id === proposal.id),
      ).toHaveLength(1)
      expect(streams).toBe(mode === 'stream' ? 1 : 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000)
      })
      expect(useAgentStore.getState().messages.filter((one) => one.id === reply.id)).toHaveLength(1)
      expect(streams).toBe(mode === 'stream' ? 1 : 0)
    }
    expect(methods.every((method) => method === 'GET')).toBe(true)
  } finally {
    releaseSnapshot()
    act(() => {
      root.unmount()
      useAgentStore.getState().startNewConversation()
    })
    host.remove()
    await vi.advanceTimersByTimeAsync(6_000)
    vi.useRealTimers()
    vi.unstubAllGlobals()
    setClientStorageScope('')
  }
})
