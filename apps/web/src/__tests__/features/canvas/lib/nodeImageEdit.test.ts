// @vitest-environment jsdom

import {
  canvasMainResult,
  canvasOrigin,
  canvasResults,
  chooseCanvasResult,
  createCanvasUndoManager,
  insertCanvasNode,
  promoteCanvasResultMedia,
  recordCanvasResult,
} from '@image-playground/shared'
import { beforeEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import {
  finishNodeImageEdit,
  type ImageEditStroke,
  openNodeImageEdit,
} from '../../../../features/canvas/lib/nodeImageEdit'

const mocks = vi.hoisted(() => ({
  submit: vi.fn(() => true),
  refusal: vi.fn((): string | null => null),
  encode: vi.fn(async () => new Blob(['edited'])),
}))
vi.mock('../../../../features/canvas/lib/nodeCanvasGenerate', () => ({
  submitNodeImage: mocks.submit,
}))
vi.mock('../../../../features/canvas/lib/submitInpaint', () => ({ inpaintRefusal: mocks.refusal }))
vi.mock('../../../../lib/canvasImage', () => ({
  loadImage: async () => ({ naturalWidth: 200, naturalHeight: 100 }),
  canvasToBlob: mocks.encode,
}))
vi.mock('../../../../lib/cloudMedia', () => ({
  resolveMediaSource: async (s: string) => s,
  blobDataUrl: async () => 'data:image/png;base64,edited',
}))
vi.mock('../../../../lib/maskPreprocess', () => ({
  prepareMaskTargetDataUrl: async () => ({
    dataUrl: 'normalized-original',
    width: 100,
    height: 50,
  }),
}))
vi.mock('../../../../features/canvas/lib/inpaintMask', () => ({
  paintMaskStroke: vi.fn(),
  exportMaskDataUrl: vi.fn(async () => 'mask'),
}))
const strokes: ImageEditStroke[] = [
  { tool: 'brush', color: '#ff0000', width: 12, points: [{ x: 20, y: 20 }] },
]
function fixture() {
  const doc = new Y.Doc(),
    origin = canvasOrigin('user', 'test')
  const editor = new CanvasEditor(new CanvasDoc())
  const fileId = editor.doc.cacheBitmap('original')
  insertCanvasNode(
    doc,
    { id: 'image', type: 'image', x: 5, y: 6, width: 300, height: 150, data: { fileId } },
    canvasOrigin('system', 'fixture'),
  )
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = {
    doc,
    origin,
    undo,
    destroy: async () => {
      undo.destroy()
      doc.destroy()
    },
  }
  return { editor, canvas }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.refusal.mockReturnValue(null)
  mocks.encode.mockResolvedValue(new Blob(['edited']))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D)
})
it('saves strokes as a new candidate on the original node; undo restores the original', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  expect(await finishNodeImageEdit(editor, canvas, source, 'draw', strokes, '')).toBe(true)
  expect(canvasResults(canvas.doc, 'image')).toHaveLength(2)
  expect(canvasMainResult(canvas.doc, 'image')?.source).not.toEqual({
    type: 'file',
    fileId: source.fileId,
  })
  canvas.undo.undo()
  expect(canvasMainResult(canvas.doc, 'image')?.source).toEqual({
    type: 'file',
    fileId: source.fileId,
  })
  expect(mocks.submit).not.toHaveBeenCalled()
})
it('submits normalized original and matching mask, never canvas annotations', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  editor.doc.elements = [
    {
      id: 'annotation',
      type: 'text',
      text: 'DO NOT SEND',
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      fontSize: 12,
      fill: 'red',
    },
  ]
  expect(await finishNodeImageEdit(editor, canvas, source, 'inpaint', strokes, 'blue sky')).toBe(
    true,
  )
  expect(mocks.submit).toHaveBeenCalledWith(
    editor,
    canvas.doc,
    'image',
    'blue sky',
    ['normalized-original'],
    { maskDataUrl: 'mask' },
  )
})
it('rejects unsupported native masks without launching generation', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  mocks.refusal.mockReturnValue('unsupported')
  await expect(
    finishNodeImageEdit(editor, canvas, source, 'inpaint', strokes, 'edit'),
  ).rejects.toThrow('unsupported')
  expect(mocks.submit).not.toHaveBeenCalled()
})
it('does not overwrite a source changed during encoding', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  mocks.encode.mockImplementationOnce(async () => {
    recordCanvasResult(
      canvas.doc,
      {
        id: 'replacement',
        nodeId: 'image',
        kind: 'image',
        createdAt: Date.now(),
        source: { type: 'file', fileId: 'replacement' },
      },
      canvas.origin,
    )
    chooseCanvasResult(
      canvas.doc,
      'image',
      'replacement',
      { data: { fileId: 'replacement' } },
      canvas.origin,
    )
    return new Blob(['edited'])
  })
  await expect(finishNodeImageEdit(editor, canvas, source, 'draw', strokes, '')).rejects.toThrow()
  expect(canvasResults(canvas.doc, 'image')).toHaveLength(2)
  expect(canvasMainResult(canvas.doc, 'image')?.id).toBe('replacement')
  expect(mocks.submit).not.toHaveBeenCalled()
})
it('uses only the isolated marked bitmap for circle-and-edit generation', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  await finishNodeImageEdit(editor, canvas, source, 'annotate', strokes, 'make blue')
  expect(mocks.submit).toHaveBeenCalledWith(
    editor,
    canvas.doc,
    'image',
    expect.stringContaining('make blue'),
    ['data:image/png;base64,edited'],
    {},
  )
})

it('allows cloud promotion of the same image while editing', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  promoteCanvasResultMedia(
    canvas.doc,
    'image',
    source.fileId,
    '00000000-0000-4000-8000-000000000001',
    canvasOrigin('system', 'promotion'),
  )
  expect(await finishNodeImageEdit(editor, canvas, source, 'draw', strokes, '')).toBe(true)
  expect(canvasResults(canvas.doc, 'image')).toHaveLength(2)
})
it('rechecks native mask support after asynchronous mask preparation', async () => {
  const { editor, canvas } = fixture()
  const source = await openNodeImageEdit(editor, canvas, 'image')
  mocks.refusal.mockReturnValueOnce(null).mockReturnValueOnce('model changed')
  await expect(
    finishNodeImageEdit(editor, canvas, source, 'inpaint', strokes, 'edit'),
  ).rejects.toThrow('model changed')
  expect(mocks.submit).not.toHaveBeenCalled()
})
