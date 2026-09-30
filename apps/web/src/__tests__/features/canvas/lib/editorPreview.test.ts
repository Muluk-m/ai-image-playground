// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

// Record the export scene instead of relying on a native canvas implementation.
const shapes = vi.hoisted(() => [] as Array<{ kind: string; fill?: string }>)
vi.mock('konva', () => ({
  default: {
    Stage: class {
      add() {}
      scale() {}
      position() {}
      toDataURL() {
        return 'data:image/png;base64,preview'
      }
      destroy() {}
    },
    Layer: class {
      add(shape: { kind: string; fill?: string }) {
        shapes.push(shape)
      }
      draw() {}
    },
    Rect: class {
      kind = 'background'
      fill: string
      constructor(props: { fill: string }) {
        this.fill = props.fill
      }
    },
    Image: class {
      kind = 'image'
    },
  },
}))
vi.mock('../../../../features/canvas/lib/imageCache', () => ({
  loadImage: async () => ({}),
}))

afterEach(() => {
  shapes.length = 0
})

it('keeps transparent preview pixels while model input exports still receive a white background', async () => {
  const doc = new CanvasDoc()
  doc.restore(
    [
      {
        id: 'logo',
        type: 'image',
        fileId: 'file',
        x: 0,
        y: 0,
        width: 300,
        height: 100,
        rotation: 0,
      },
    ],
    { file: 'data:image/png;base64,logo' },
  )
  const editor = new CanvasEditor(doc)
  const sink = createAgentCanvasSink(editor)
  expect(await sink.thumbnail('logo', 2.5)).toContain('data:image/png')
  expect(shapes).toEqual([expect.objectContaining({ kind: 'image' })])

  shapes.length = 0
  await editor.toImage(['logo'])
  expect(shapes).toEqual([
    expect.objectContaining({ kind: 'background', fill: '#ffffff' }),
    expect.objectContaining({ kind: 'image' }),
  ])
})
