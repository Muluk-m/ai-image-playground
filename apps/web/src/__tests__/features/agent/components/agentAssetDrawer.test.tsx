// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentAssetDrawer from '../../../../features/agent/components/AgentAssetDrawer'
import type { AgentToolMessage } from '../../../../features/agent/types'

const fixture = vi.hoisted(() => ({
  fetchConversations: vi.fn(async () => [{ id: 'other-1' }, { id: 'other-2' }]),
  fetchMessages: vi.fn(async (_id: string): Promise<unknown> => ({ messages: [], turns: [] })),
  fetchBatchPlan: vi.fn(
    async (_id: string): Promise<unknown> => ({ batch: { status: 'paused' }, items: [] }),
  ),
  fetchMessageReference: vi.fn(async () => new Blob()),
  resolveMediaSource: vi.fn(
    async (_source: string, _variant?: string) => 'data:image/png;base64,preview',
  ),
}))

vi.mock('../../../../features/agent/lib/agentClient', () => ({
  fetchConversations: fixture.fetchConversations,
  fetchMessages: fixture.fetchMessages,
  fetchBatchPlan: fixture.fetchBatchPlan,
  fetchMessageReference: fixture.fetchMessageReference,
}))
vi.mock('../../../../lib/cloudMedia', async () => {
  const actual = await vi.importActual<typeof import('../../../../lib/cloudMedia')>(
    '../../../../lib/cloudMedia',
  )
  return { ...actual, resolveMediaSource: fixture.resolveMediaSource }
})
vi.mock('../../../../components/Lightbox', () => ({
  ImagePreview: ({ src, onClose }: { src: string; onClose: () => void }) => (
    <div data-testid="source-preview">
      <span>{src}</span>
      <button type="button" onClick={onClose}>
        close-preview
      </button>
    </div>
  ),
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: (select: (state: { conversationId: string }) => unknown) =>
    select({ conversationId: 'current' }),
}))
vi.mock('../../../../features/agent/lib/artifactPreview', () => ({
  artifactPreview: async (artifact: { artifactId: string }) => ({
    source: `data:image/png;base64,${artifact.artifactId}`,
  }),
  fetchedImagePreview: async () => ({ source: null }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const observed = new Map<Element, IntersectionObserverCallback>()
class MockIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(element: Element) {
    observed.set(element, this.callback)
  }
  disconnect() {
    for (const [element, callback] of observed) {
      if (callback === this.callback) observed.delete(element)
    }
  }
}

function item(id: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: id,
    toolCallId: id,
    title: `Result ${id}`,
    status: 'succeeded',
    artifacts: [{ artifactId: id, media: 'image', taskId: id, outputIndex: 0, mime: 'image/png' }],
  }
}

function history(prefix: string, count: number) {
  return {
    messages: Array.from({ length: count }, (_, index) => {
      const id = `${prefix}-${index}`
      return {
        id,
        turnId: id,
        role: 'assistant',
        content: [
          {
            type: 'toolResult',
            toolCallId: id,
            title: `Result ${id}`,
            status: 'succeeded',
            artifacts: [
              { artifactId: id, media: 'image', taskId: id, outputIndex: 0, mime: 'image/png' },
            ],
          },
        ],
      }
    }),
    turns: [],
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  observed.clear()
  fixture.fetchConversations.mockClear()
  fixture.fetchMessages.mockReset()
  fixture.fetchBatchPlan.mockReset()
  fixture.fetchBatchPlan.mockResolvedValue({ batch: { status: 'paused' }, items: [] })
  fixture.fetchMessageReference.mockClear()
  fixture.resolveMediaSource.mockReset()
  fixture.resolveMediaSource.mockResolvedValue('data:image/png;base64,preview')
  fixture.fetchMessages.mockImplementation(async (id) => history(id, id === 'other-1' ? 30 : 2))
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function scrollToEnd() {
  const end = document.querySelector('.studio-assets-end')
  expect(end).not.toBeNull()
  const callback = observed.get(end!)
  expect(callback).toBeDefined()
  await act(async () => {
    callback!([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  })
}

it('loads only the visible page and fetches older conversation histories as the asset grid reaches its end', async () => {
  await act(async () => {
    root.render(
      <AgentAssetDrawer
        messages={Array.from({ length: 30 }, (_, index) => item(`current-${index}`))}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    )
  })
  const all = [...document.querySelectorAll<HTMLButtonElement>('.studio-assets-tabs button')][1]!
  await act(async () => all.click())
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(24)
  expect(fixture.fetchConversations).not.toHaveBeenCalled()
  expect(fixture.fetchMessages).not.toHaveBeenCalled()

  await scrollToEnd()
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(48)
  expect(fixture.fetchMessages).toHaveBeenCalledTimes(1)
  expect(fixture.fetchMessages).toHaveBeenCalledWith('other-1')

  // Streaming replies replace messages without invalidating loaded history or its cursor.
  await act(async () =>
    root.render(
      <AgentAssetDrawer
        messages={Array.from({ length: 30 }, (_, index) => item(`current-${index}`))}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    ),
  )
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(48)
  expect(fixture.fetchMessages).toHaveBeenCalledTimes(1)

  await act(async () =>
    root.render(
      <AgentAssetDrawer
        messages={[
          item('new-result'),
          ...Array.from({ length: 30 }, (_, index) => item(`current-${index}`)),
        ]}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    ),
  )
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(49)
  expect(fixture.fetchMessages).toHaveBeenCalledTimes(1)

  await scrollToEnd()
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(63)
  expect(fixture.fetchMessages).toHaveBeenCalledTimes(2)
  expect(fixture.fetchMessages).toHaveBeenLastCalledWith('other-2')
  expect(document.querySelector('.studio-assets-end')).toBeNull()
})

it('lists the source images of a batch plan when the chat itself has no generated results', async () => {
  fixture.fetchBatchPlan.mockResolvedValue({
    batch: { status: 'paused' },
    items: [
      { inputs: [{ imageId: 'i1', mediaId: 'm1', name: '01-主图场景' }], progress: 'ready' },
      {
        inputs: [{ imageId: 'i2', mediaId: 'm2', name: '02-场景二-烛光深色墙' }],
        progress: 'ready',
      },
    ],
  })
  await act(async () => {
    root.render(
      <AgentAssetDrawer
        messages={[
          {
            kind: 'tool',
            id: 'plan',
            turnId: 'turn',
            toolCallId: 'call',
            batchId: 'batch-1',
            title: '48张图片背景优化计划',
            status: 'succeeded',
          },
        ]}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    )
  })
  await vi.waitFor(() => expect(document.body.textContent).toContain('01-主图场景'))
  expect(document.body.textContent).toContain('02-场景二-烛光深色墙')
  expect(document.body.textContent).not.toContain('这段对话还没有产物')
  expect(fixture.fetchBatchPlan).toHaveBeenCalledWith('batch-1')
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(2)
})

function planMessage(id: string, batchId: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: id,
    toolCallId: id,
    batchId,
    title: '计划',
    status: 'succeeded',
  }
}

it('lists each shared input once and keeps images from the batches that did load', async () => {
  fixture.fetchBatchPlan.mockImplementation(async (id: string) => {
    if (id === 'batch-missing') throw new Error('missing')
    return {
      batch: { status: 'paused' },
      items: [
        {
          inputs: [{ imageId: id, mediaId: 'shared-media', name: `${id}-原图` }],
          progress: 'ready',
        },
      ],
    }
  })
  await act(async () => {
    root.render(
      <AgentAssetDrawer
        messages={[
          planMessage('one', 'batch-1'),
          planMessage('two', 'batch-2'),
          planMessage('three', 'batch-missing'),
        ]}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    )
  })
  await vi.waitFor(() => expect(document.body.textContent).toContain('batch-1-原图'))
  expect(document.body.textContent).not.toContain('batch-2-原图')
  expect(document.body.textContent).toContain('这批图片暂时没能载入')
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(1)
})

it('keeps refreshing a paused batch while a submitted item is still running', async () => {
  vi.useFakeTimers()
  try {
    fixture.fetchBatchPlan.mockResolvedValue({
      batch: { status: 'paused' },
      items: [
        {
          inputs: [{ imageId: 'i1', mediaId: 'm1', name: '还在生成' }],
          progress: 'in_flight',
          execution: { status: 'in_progress' },
        },
      ],
    })
    await act(async () => {
      root.render(
        <AgentAssetDrawer
          messages={[planMessage('plan', 'batch-1')]}
          onClose={() => {}}
          onPreview={() => {}}
        />,
      )
    })
    expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000)
    })
    expect(fixture.fetchBatchPlan).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})

it('shows the newest source preview and does not reopen it after it is closed', async () => {
  let finishSlow: (value: string) => void = () => {}
  const slow = new Promise<string>((resolve) => {
    finishSlow = resolve
  })
  fixture.resolveMediaSource.mockImplementation(async (source: string, variant?: string) => {
    if (variant === 'original' && source.endsWith('m-slow')) return slow
    if (variant === 'original') return 'data:image/png;base64,fast'
    return 'data:image/png;base64,preview'
  })
  fixture.fetchBatchPlan.mockResolvedValue({
    batch: { status: 'paused' },
    items: [
      { inputs: [{ imageId: 'i1', mediaId: 'm-slow', name: '慢图' }], progress: 'ready' },
      { inputs: [{ imageId: 'i2', mediaId: 'm-fast', name: '快图' }], progress: 'ready' },
    ],
  })
  await act(async () => {
    root.render(
      <AgentAssetDrawer
        messages={[planMessage('plan', 'batch-1')]}
        onClose={() => {}}
        onPreview={() => {}}
      />,
    )
  })
  await vi.waitFor(() => expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(2))
  const [slowButton, fastButton] =
    document.querySelectorAll<HTMLButtonElement>('.studio-assets-item')
  await act(async () => {
    slowButton!.click()
    fastButton!.click()
  })
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="source-preview"] span')?.textContent).toBe(
      'data:image/png;base64,fast',
    ),
  )
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[data-testid="source-preview"] button')!.click()
  })
  expect(document.querySelector('[data-testid="source-preview"]')).toBeNull()
  await act(async () => {
    finishSlow('data:image/png;base64,slow')
  })
  expect(document.querySelector('[data-testid="source-preview"]')).toBeNull()
})
