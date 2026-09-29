// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentAssetDrawer from '../../../../features/agent/components/AgentAssetDrawer'
import type { AgentToolMessage } from '../../../../features/agent/types'

const fixture = vi.hoisted(() => ({
  fetchConversations: vi.fn(async () => [{ id: 'other-1' }, { id: 'other-2' }]),
  fetchMessages: vi.fn(async (_id: string): Promise<unknown> => ({ messages: [], turns: [] })),
}))

vi.mock('../../../../features/agent/lib/agentClient', () => ({
  fetchConversations: fixture.fetchConversations,
  fetchMessages: fixture.fetchMessages,
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

  await scrollToEnd()
  expect(document.querySelectorAll('.studio-assets-item')).toHaveLength(62)
  expect(fixture.fetchMessages).toHaveBeenCalledTimes(2)
  expect(fixture.fetchMessages).toHaveBeenLastCalledWith('other-2')
  expect(document.querySelector('.studio-assets-end')).toBeNull()
})
