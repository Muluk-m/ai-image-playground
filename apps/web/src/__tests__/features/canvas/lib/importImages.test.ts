// @vitest-environment jsdom
import { canvasOrigin, createCanvasUndoManager, readCanvasDocument } from '@image-playground/shared'
import { expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { importImageFiles } from '../../../../features/canvas/lib/importImages'
import { createNode } from '../../../../features/canvas/lib/nodeCanvasActions'
import {
  clearNodeCanvasSelection,
  setNodeCanvasSelection,
} from '../../../../features/canvas/lib/nodeCanvasSelection'

vi.mock('../../../../lib/canvasImage', () => ({
  getImageDimensions: vi.fn(),
}))

import { getImageDimensions } from '../../../../lib/canvasImage'

it('keeps imported images but does not reselect them after reference context is cleared', async () => {
  let finish!: (value: { width: number; height: number }) => void
  vi.mocked(getImageDimensions).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const editor = new CanvasEditor(new CanvasDoc())
  const place = vi.spyOn(editor, 'placeImages').mockReturnValue(['imported'])
  const select = vi.spyOn(editor, 'setSelectedElements')
  let selectImported = true
  const imported = importImageFiles(
    editor,
    [new File(['image'], 'old.png', { type: 'image/png' })],
    { x: 0, y: 0 },
    () => selectImported,
  )
  await vi.waitFor(() => expect(getImageDimensions).toHaveBeenCalled())
  selectImported = false
  finish({ width: 100, height: 100 })
  expect(await imported).toBe(1)
  expect(place).toHaveBeenCalledOnce()
  expect(select).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})

it('places an imported batch clear of existing images without moving them', async () => {
  vi.mocked(getImageDimensions).mockResolvedValue({ width: 100, height: 100 })
  const doc = new CanvasDoc()
  const editor = new CanvasEditor(doc)
  const [existingId] = editor.placeImages([
    { dataUrl: 'data:image/png;base64,AA==', x: -200, y: -200, width: 400, height: 400 },
  ])
  const original = structuredClone(doc.elements[0])
  await importImageFiles(
    editor,
    [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ],
    { x: 0, y: 0 },
  )
  expect(doc.getElement(existingId!)).toEqual(original)
  const imported = doc.elements
    .filter((element) => element.type === 'image')
    .filter((element) => element.id !== existingId)
  expect(imported.map((element) => ({ x: element.x, y: element.y }))).toEqual([
    { x: -124, y: 248 },
    { x: 24, y: 248 },
  ])
})

it('uses fixed media cards and avoids empty nodes when importing into the node canvas', async () => {
  vi.mocked(getImageDimensions)
    .mockResolvedValueOnce({ width: 10, height: 20 })
    .mockResolvedValueOnce({ width: 4096, height: 2048 })
  const doc = new Y.Doc()
  const origin = canvasOrigin('user', 'import-test')
  const undo = createCanvasUndoManager(doc, origin)
  const canvas = {
    doc,
    origin,
    undo,
    async destroy() {
      undo.destroy()
      doc.destroy()
    },
  }
  const editor = new CanvasEditor(new CanvasDoc())
  createNode(canvas, 'image', { x: 0, y: 0 }, '')
  const original = readCanvasDocument(doc).nodes
  setNodeCanvasSelection(editor, canvas, [])
  try {
    await importImageFiles(
      editor,
      [
        new File(['portrait'], 'portrait.png', { type: 'image/png' }),
        new File(['landscape'], 'landscape.png', { type: 'image/png' }),
      ],
      { x: 0, y: 0 },
    )
    expect(
      editor.doc.elements
        .filter((element) => element.type === 'image')
        .map((element) => ({
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        })),
    ).toEqual([
      { x: -384, y: 168, width: 360, height: 240 },
      { x: 24, y: 168, width: 360, height: 240 },
    ])
    expect(readCanvasDocument(doc).nodes).toEqual(original)
  } finally {
    clearNodeCanvasSelection(editor, canvas)
    await canvas.destroy()
  }
})
