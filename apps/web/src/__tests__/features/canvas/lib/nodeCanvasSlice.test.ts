// @vitest-environment jsdom
import {
  canvasOrigin,
  createCanvasUndoManager,
  deleteCanvasNode,
  importLegacyElements,
  readCanvasDocument,
  reconcileLegacyElements,
} from '@image-playground/shared'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { sliceCanvasImage } from '../../../../features/canvas/lib/nodeCanvasSlice'

const mocks = vi.hoisted(() => ({ slice: vi.fn(), close: vi.fn() }))
vi.mock('../../../../features/toolbox/tools/slice', () => ({ sliceImage: mocks.slice }))
vi.mock('../../../../lib/canvasImage', () => ({
  dataUrlToBlob: async () => new Blob(['original'], { type: 'image/png' }),
}))
beforeEach(() => {
  mocks.slice.mockReset()
  mocks.close.mockReset()
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1200, height: 600, close: mocks.close })),
  )
  mocks.slice.mockImplementation(async (_source, { grid }) =>
    Array.from({ length: Number(grid[0]) ** 2 }, (_, i) => ({
      blob: new Blob([`tile-${i}`], { type: 'image/jpeg' }),
      type: 'image/jpeg',
      width: 600,
      height: 300,
    })),
  )
})
afterEach(() => vi.unstubAllGlobals())
function setup() {
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'slice-test')
  const editor = new CanvasEditor(new CanvasDoc())
  editor.placeImages([
    {
      id: 'source',
      x: 0,
      y: 0,
      width: 300,
      height: 150,
      dataUrl: 'data:image/png;base64,YQ==',
      name: 'Storyboard',
    },
    {
      id: 'occupied',
      x: 396,
      y: 0,
      width: 280,
      height: 160,
      dataUrl: 'data:image/png;base64,YQ==',
    },
  ])
  importLegacyElements(doc, editor.doc.elements, canvasOrigin('system', 'fixture'))
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = { doc, origin, undo, destroy: async () => doc.destroy() }
  return { canvas, editor }
}
it.each([
  2, 3,
] as const)('slices %s×%s in row-major order, avoids existing nodes, and undoes the whole batch', async (grid) => {
  const { canvas, editor } = setup()
  const ids = await sliceCanvasImage(editor, canvas, 'source', grid)
  expect(ids).toHaveLength(grid ** 2)
  const result = readCanvasDocument(canvas.doc)
  const nodes = ids.map((id) => result.nodes.find((n) => n.id === id)!)
  expect(nodes.map((n) => ('name' in n.data ? n.data.name : undefined))).toEqual(
    ids.map((_, i) => `Storyboard · ${i + 1}`),
  )
  expect(nodes[0]!.y).toBeGreaterThanOrEqual(240 + 48)
  expect(nodes[1]!.x).toBeGreaterThan(nodes[0]!.x)
  expect(nodes[1]!.y).toBe(nodes[0]!.y)
  expect(nodes[grid]!.x).toBe(nodes[0]!.x)
  expect(nodes[grid]!.y).toBeGreaterThan(nodes[0]!.y)
  expect(result.edges).toHaveLength(grid ** 2)
  for (const node of nodes) {
    expect(node).toMatchObject({ width: 360, height: 240 })
    expect(node.data).toMatchObject({ naturalWidth: 600, naturalHeight: 300 })
    expect('fileId' in node.data && editor.doc.files[node.data.fileId!]).toMatch(
      /^data:image\/jpeg/,
    )
  }
  expect(mocks.slice.mock.calls[0]![1]).toEqual({ grid: `${grid}x${grid}`, squareFirst: false })
  expect(mocks.close).toHaveBeenCalledOnce()
  canvas.undo.undo()
  reconcileLegacyElements(canvas.doc, editor.doc.elements, canvasOrigin('system', 'reopen'))
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(2)
  expect(readCanvasDocument(canvas.doc).edges).toHaveLength(0)
  canvas.undo.redo()
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(2 + grid ** 2)
})
it('leaves no partial nodes on crop failure and releases the bitmap', async () => {
  const { canvas, editor } = setup()
  mocks.slice.mockRejectedValueOnce(new Error('encode failed'))
  await expect(sliceCanvasImage(editor, canvas, 'source', 3)).rejects.toThrow('encode failed')
  expect(readCanvasDocument(canvas.doc).nodes).toHaveLength(2)
  expect(editor.doc.elements).toHaveLength(2)
  expect(mocks.close).toHaveBeenCalledOnce()
})
it('does not restore a source deleted while slicing', async () => {
  const { canvas, editor } = setup()
  mocks.slice.mockImplementationOnce(async () => {
    deleteCanvasNode(canvas.doc, 'source', canvas.origin)
    return []
  })
  expect(await sliceCanvasImage(editor, canvas, 'source', 2)).toEqual([])
  expect(readCanvasDocument(canvas.doc).nodes.map((n) => n.id)).toEqual(['occupied'])
  expect(editor.doc.elements).toHaveLength(2)
})
