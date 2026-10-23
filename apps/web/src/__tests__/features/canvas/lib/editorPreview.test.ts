// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

// Record the export scene instead of relying on a native canvas implementation.
const shapes = vi.hoisted(() => [] as Array<{ kind: string; fill?: string; props?: unknown }>)
const stages = vi.hoisted(() => [] as Array<{ width: number; height: number }>)
vi.mock('konva', () => ({
  default: {
    Stage: class {
      constructor(props: { width: number; height: number }) {
        stages.push({ width: props.width, height: props.height })
      }
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
      props: unknown
      constructor(props: Record<string, unknown>) {
        const { image: _image, ...rest } = props
        this.props = rest
      }
    },
  },
}))
vi.mock('../../../../features/canvas/lib/imageCache', () => ({
  loadImage: async () => ({}),
}))

afterEach(() => {
  shapes.length = 0
  stages.length = 0
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

it("result thumbnails keep a 16:9 output's aspect ratio even when its canvas frame is square", async () => {
  const doc = new CanvasDoc()
  doc.restore(
    [
      {
        id: 'out',
        type: 'image',
        fileId: 'file',
        x: 24,
        y: 0,
        width: 360,
        height: 360,
        rotation: 0,
        naturalWidth: 3840,
        naturalHeight: 2160,
      },
    ],
    { file: 'data:image/png;base64,out' },
  )
  const sink = createAgentCanvasSink(new CanvasEditor(doc))
  await sink.thumbnail('out', 2.5)
  // 900×506，不是把 16:9 的图压进 900×900。
  expect(stages).toEqual([{ width: 900, height: 506 }])
  expect(shapes).toEqual([
    expect.objectContaining({
      kind: 'image',
      props: expect.objectContaining({ x: 24, y: 78.75, width: 360, height: 202.5 }),
    }),
  ])
})

it('model-input exports of a framed image are unchanged', async () => {
  const doc = new CanvasDoc()
  doc.restore(
    [
      {
        id: 'out',
        type: 'image',
        fileId: 'file',
        x: 0,
        y: 0,
        width: 360,
        height: 360,
        rotation: 0,
        naturalWidth: 3840,
        naturalHeight: 2160,
      },
    ],
    { file: 'data:image/png;base64,out' },
  )
  await new CanvasEditor(doc).toImage(['out'])
  expect(stages).toEqual([{ width: 360, height: 360 }])
})
