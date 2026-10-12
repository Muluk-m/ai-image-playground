import {
  canvasOrigin,
  importLegacyElements,
  insertCanvasNode,
  readCanvasDocument,
} from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { submitNodeImage } from '../../../../features/canvas/lib/nodeCanvasGenerate'

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
