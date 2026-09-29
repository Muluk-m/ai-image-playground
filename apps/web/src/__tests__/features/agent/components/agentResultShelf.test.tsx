// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import AgentResultShelf from '../../../../features/agent/components/AgentResultShelf'
import type { AgentToolMessage } from '../../../../features/agent/types'
import type { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'

const fixture = vi.hoisted(() => ({
  messages: [] as AgentToolMessage[],
  has: vi.fn((_id: string) => true),
  focus: vi.fn(),
  placeOnCanvas: vi.fn(async (_id: string) => {}),
}))

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (state: typeof fixture) => unknown) => select(fixture), {
    getState: () => fixture,
  }),
}))
vi.mock('../../../../features/agent/lib/canvasSink', () => ({
  agentCanvasSink: () => ({ has: fixture.has, focus: fixture.focus }),
}))
vi.mock('../../../../features/agent/lib/artifactPreview', () => ({
  artifactPreview: async (artifact: { artifactId: string }) => ({
    source: `preview:${artifact.artifactId}`,
  }),
  fetchedImagePreview: async () => ({ source: null }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function result(id: string): AgentToolMessage {
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

const doc = {
  version: 0,
  subscribe: () => () => {},
} as unknown as CanvasDoc

afterEach(() => {
  fixture.messages = []
  fixture.has.mockClear()
  fixture.focus.mockClear()
  fixture.placeOnCanvas.mockClear()
  document.body.innerHTML = ''
})

it('keeps the newest result on the canvas and makes every earlier group reachable', async () => {
  fixture.messages = Array.from({ length: 19 }, (_, index) => result(String(index)))
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<AgentResultShelf doc={doc} />))
    expect(host.textContent).toContain('18 组')
    expect(host.textContent).toContain('Result 17')
    expect(host.textContent).not.toContain('Result 18')
    expect(host.textContent).not.toContain('Result 0')

    for (let page = 0; page < 2; page++) {
      const more = host.querySelector<HTMLButtonElement>('.studio-result-shelf-more')
      expect(more).not.toBeNull()
      await act(async () => more?.click())
    }
    expect(host.textContent).toContain('Result 0')
    fixture.has.mockImplementation((id) => id !== '0')
    const oldest = [...host.querySelectorAll<HTMLButtonElement>('.studio-result-shelf-item')].find(
      (button) => button.textContent?.includes('Result 0'),
    )
    await act(async () => oldest?.click())
    expect(fixture.placeOnCanvas).toHaveBeenCalledWith('0')
    expect(fixture.focus).toHaveBeenCalledWith(['0'])
  } finally {
    act(() => root.unmount())
  }
})
