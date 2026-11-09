// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentRequestError } from '../../../../features/agent/lib/agentClient'
import type { AgentPanelMessage } from '../../../../features/agent/types'
import { useCanvasAssets } from '../../../../features/canvas/lib/useCanvasAssets'
import { setClientStorageScope } from '../../../../lib/authScope'

const fixture = vi.hoisted(() => ({
  messages: [] as AgentPanelMessage[],
  fetchBatchPlan: vi.fn(
    async (_id: string): Promise<unknown> => ({ batch: { status: 'closed' }, items: [] }),
  ),
  changes: new Set<(batchId: string) => void>(),
  fetchMessages: vi.fn(async () => ({ messages: [], turns: [] })),
}))
vi.mock('../../../../features/agent/lib/agentClient', () => ({
  AgentRequestError: class extends Error {
    constructor(readonly status: number) {
      super(`Agent request failed with ${status}`)
    }
  },
  fetchBatchPlan: fixture.fetchBatchPlan,
  fetchMessages: fixture.fetchMessages,
  fetchConversations: vi.fn(async () => []),
  subscribeBatchPlanChanges: (listener: (batchId: string) => void) => {
    fixture.changes.add(listener)
    return () => {
      fixture.changes.delete(listener)
    }
  },
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: (
    select: (state: { conversationId: string; messages: AgentPanelMessage[] }) => unknown,
  ) => select({ conversationId: 'conversation', messages: fixture.messages }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
function Harness() {
  const assets = useCanvasAssets('conversation', 'project')
  return (
    <div>
      {assets.failed ? 'failed' : 'ok'}:{assets.items.length}
    </div>
  )
}
function plans(...ids: string[]): AgentPanelMessage[] {
  return ids.map((batchId) => ({
    kind: 'tool',
    id: batchId,
    turnId: 'turn',
    toolCallId: batchId,
    title: batchId,
    status: 'succeeded',
    batchId,
  }))
}
beforeEach(() => {
  vi.useFakeTimers()
  setClientStorageScope('canvas-account')
  fixture.fetchBatchPlan.mockReset()
  fixture.fetchMessages.mockClear()
  fixture.changes.clear()
  fixture.messages = plans('closed', 'paused', 'running')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setClientStorageScope(null)
  vi.useRealTimers()
})

it('retains finished results while querying only batches with active work', async () => {
  fixture.fetchBatchPlan.mockImplementation(async (id) => ({
    batch: { status: id === 'closed' ? 'closed' : id === 'paused' ? 'paused' : 'running' },
    items:
      id === 'paused'
        ? [{ progress: 'reconciling', inputs: [] }]
        : id === 'closed'
          ? [
              {
                progress: 'completed',
                inputs: [],
                execution: {
                  status: 'completed',
                  artifacts: [
                    {
                      artifactId: 'finished',
                      taskId: 'task',
                      media: 'image',
                      outputIndex: 0,
                      mime: 'image/png',
                    },
                  ],
                },
              },
            ]
          : [],
  }))
  await act(async () => root.render(<Harness />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_000)
  })
  expect(host.textContent).toBe('ok:1')
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'closed')).toHaveLength(1)
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'paused')).toHaveLength(4)
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'running')).toHaveLength(4)
  await act(async () => root.render(null))
  await vi.advanceTimersByTimeAsync(12_000)
  expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(9)
})

it('shows results from a resumed batch without reopening assets or repolling it after completion', async () => {
  let resumed = false
  fixture.messages = plans('running', 'paused')
  fixture.fetchBatchPlan.mockImplementation(async (id) => ({
    batch: { status: id === 'running' ? 'running' : resumed ? 'closed' : 'paused' },
    items:
      id === 'paused' && resumed
        ? [
            {
              inputs: [],
              progress: 'completed',
              execution: {
                status: 'completed',
                artifacts: [
                  {
                    artifactId: 'resumed-output',
                    taskId: 'resumed-task',
                    media: 'image',
                    outputIndex: 0,
                    mime: 'image/png',
                  },
                ],
              },
            },
          ]
        : [],
  }))
  function Results() {
    const assets = useCanvasAssets('conversation', 'project')
    return (
      <div>
        {assets.items.map((one) => (
          <span key={one.id}>{one.id}</span>
        ))}
      </div>
    )
  }
  await act(async () => root.render(<Results />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'paused')).toHaveLength(1)
  await act(async () => {
    resumed = true
    for (const listener of fixture.changes) listener('paused')
  })
  expect(host.textContent).toContain('resumed-output')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'paused')).toHaveLength(2)
  const reads = fixture.fetchBatchPlan.mock.calls.length
  await act(async () => root.render(null))
  for (const listener of fixture.changes) listener('paused')
  expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(reads)
})

it.each([
  403, 404,
])('stops inaccessible batches after HTTP %s while other batches keep refreshing', async (status) => {
  fixture.messages = plans('missing', 'running')
  fixture.fetchBatchPlan.mockImplementation(async (id) => {
    if (id === 'missing') throw new AgentRequestError(status)
    return { batch: { status: 'running' }, items: [] }
  })
  await act(async () => root.render(<Harness />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(8_000)
  })
  expect(host.textContent).toBe('failed:0')
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'missing')).toHaveLength(1)
  expect(fixture.fetchBatchPlan.mock.calls.filter(([id]) => id === 'running')).toHaveLength(3)
})

it('retries a transient failure even if all other batches are already finished', async () => {
  fixture.messages = plans('batch')
  fixture.fetchBatchPlan.mockRejectedValueOnce(new Error('network'))
  fixture.fetchBatchPlan.mockResolvedValue({ batch: { status: 'closed' }, items: [] })
  await act(async () => root.render(<Harness />))
  expect(host.textContent).toBe('failed:0')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4_000)
  })
  expect(host.textContent).toBe('ok:0')
  await vi.advanceTimersByTimeAsync(8_000)
  expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(2)
})

it('discards an old account response and starts a separate read after an account change', async () => {
  fixture.messages = plans('batch')
  // The web package targets ES2020, which does not include Promise.withResolvers.
  let finish!: (page: unknown) => void
  fixture.fetchBatchPlan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  fixture.fetchBatchPlan.mockResolvedValue({ batch: { status: 'closed' }, items: [] })
  await act(async () => root.render(<Harness />))
  setClientStorageScope('other-canvas-account')
  await act(async () => root.render(<Harness />))
  await act(async () =>
    finish({
      batch: { status: 'running' },
      items: [
        {
          inputs: [],
          execution: {
            status: 'completed',
            artifacts: [
              {
                artifactId: 'old',
                taskId: 'old',
                media: 'image',
                outputIndex: 0,
                mime: 'image/png',
              },
            ],
          },
        },
      ],
    }),
  )
  expect(host.textContent).toBe('ok:0')
  await vi.advanceTimersByTimeAsync(8_000)
  expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(2)
})
