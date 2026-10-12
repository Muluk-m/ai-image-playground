import {
  canvasOrigin,
  connectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { submitNodeImage } from '../../../../features/canvas/lib/nodeCanvasGenerate'
import { useStore } from '../../../../store'

const mocks = vi.hoisted(() => ({ start: vi.fn() }))

vi.mock('../../../../lib/generationJob', () => ({
  startGeneration: mocks.start,
  resumeGeneration: vi.fn(),
}))

describe('submitNodeImage', () => {
  beforeEach(() => {
    mocks.start.mockReset()
    mocks.start.mockImplementation((spec, sink) => {
      const variant = spec.variants[0]
      return [
        sink.open({
          prompt: variant.prompt,
          params: spec.params,
          inputImageDataUrls: variant.inputImageDataUrls,
          clientRequestId: 'req-1',
          index: 0,
          context: variant.context,
        }),
      ]
    })
  })

  it('marks the same image node as generating', () => {
    const ydoc = new Y.Doc()
    importLegacyElements(ydoc, [], canvasOrigin('system', 'fixture'))
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      canvasOrigin('system', 'node-insert'),
    )
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '屋顶看星星', [])).toBe(true)
    expect(readCanvasDocument(ydoc).nodes.find((node) => node.id === 'card')!.data).toMatchObject({
      pending: { type: 'placeholder', status: 'loading' },
    })
    expect(mocks.start.mock.calls[0]![0].params.n).toBe(useStore.getState().params.n)
  })

  it('opens a sibling card for each extra fan-out index and keeps the same incoming edge', () => {
    mocks.start.mockImplementation((spec, sink) => {
      const variant = spec.variants[0]
      return [0, 1].map((index) =>
        sink.open({
          prompt: variant.prompt,
          params: spec.params,
          inputImageDataUrls: variant.inputImageDataUrls,
          clientRequestId: `req-${index}`,
          index,
          context: variant.context,
        }),
      )
    })
    const ydoc = new Y.Doc()
    importLegacyElements(ydoc, [], canvasOrigin('system', 'fixture'))
    const origin = canvasOrigin('system', 'node-insert')
    insertCanvasNode(
      ydoc,
      { id: 'upstream', type: 'image', x: -200, y: 0, width: 80, height: 80, data: {} },
      origin,
    )
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      origin,
    )
    connectCanvasNodes(ydoc, { source: 'upstream', target: 'card' }, origin)
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '两张', [])).toBe(true)
    const images = readCanvasDocument(ydoc).nodes.filter((node) => node.type === 'image')
    expect(images).toHaveLength(3)
    const sibling = images.find((node) => node.id !== 'card' && node.id !== 'upstream')
    expect(sibling).toMatchObject({ y: 0, data: { pending: { status: 'loading' } } })
    expect(sibling!.x).toBeGreaterThan(0)
    expect(
      readCanvasDocument(ydoc).edges.some(
        (edge) => edge.source === 'upstream' && edge.target === sibling!.id,
      ),
    ).toBe(true)
  })

  it('does not start when there is nothing to say and nothing to reference', () => {
    const ydoc = new Y.Doc()
    insertCanvasNode(
      ydoc,
      { id: 'card', type: 'image', x: 0, y: 0, width: 280, height: 280, data: {} },
      canvasOrigin('system', 'node-insert'),
    )
    const editor = new CanvasEditor(new CanvasDoc())
    expect(submitNodeImage(editor, ydoc, 'card', '   ', [])).toBe(false)
    expect(mocks.start).not.toHaveBeenCalled()
  })
})
