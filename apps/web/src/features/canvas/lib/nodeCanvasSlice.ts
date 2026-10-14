import {
  canvasNodeKind,
  connectCanvasNodes,
  insertCanvasNode,
  readCanvasDocument,
  synchronizeLegacyElements,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { dataUrlToBlob } from '../../../lib/canvasImage'
import { sliceImage } from '../../toolbox/tools/slice'
import { newElementId } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { fileToDataUrl } from './importImages'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

/** Reuse the toolbox's local cropper; only publish the complete batch after all tiles encode. */
export async function sliceCanvasImage(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  sourceId: string,
  grid: 2 | 3,
): Promise<string[]> {
  const original = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === sourceId)
  if (!original || original.type !== 'image' || canvasNodeKind(original) !== 'image') return []
  const fileId = original.data.fileId
  const source = fileId && editor.doc.files[fileId]
  if (!source) return []
  const file = await dataUrlToBlob(source)
  const bitmap = await createImageBitmap(file)
  const name = (original.data.name || i18next.t('nodes.addImage', { ns: 'canvas' })).slice(0, 480)
  const tiles = []
  try {
    if (bitmap.width < grid || bitmap.height < grid) throw new Error('Image too small to slice')
    const outputs = await sliceImage(
      { id: sourceId, name, file, bitmap, type: file.type, size: file.size },
      { grid: grid === 2 ? '2x2' : '3x3', squareFirst: false },
    )
    for (const output of outputs) {
      tiles.push({
        ...output,
        dataUrl: await fileToDataUrl(new File([output.blob], 'tile', { type: output.type })),
      })
    }
  } finally {
    bitmap.close()
  }
  if (canvas.doc.isDestroyed) return []
  const snapshot = readCanvasDocument(canvas.doc)
  const anchor = snapshot.nodes.find((n) => n.id === sourceId)
  // A deleted or replaced source must not come back when the asynchronous crop finishes.
  if (
    !anchor ||
    anchor.type !== 'image' ||
    anchor.data.fileId !== fileId ||
    editor.doc.files[fileId!] !== source
  )
    return []
  if (tiles.length !== grid * grid) throw new Error('Incomplete image slices')
  const scale = Math.min(1, 320 / Math.max(tiles[0]!.width, tiles[0]!.height))
  const width = Math.max(1, Math.round(tiles[0]!.width * scale))
  const height = Math.max(1, Math.round(tiles[0]!.height * scale))
  const gap = 48
  const blockWidth = grid * width + (grid - 1) * gap
  const blockHeight = grid * height + (grid - 1) * gap
  const x = anchor.x + anchor.width + 96
  let y = anchor.y
  const occupied = [...snapshot.nodes, ...(snapshot.groups ?? [])]
  // Move the whole grid together into the first free band, preserving reading order.
  for (;;) {
    const collisions = occupied.filter(
      (box) =>
        x < box.x + box.width + gap &&
        x + blockWidth + gap > box.x &&
        y < box.y + box.height + gap &&
        y + blockHeight + gap > box.y,
    )
    if (!collisions.length) break
    y = Math.max(...collisions.map((box) => box.y + box.height + gap))
  }
  const items = tiles.map((tile, index) => ({
    id: newElementId(),
    dataUrl: tile.dataUrl,
    name: `${name} · ${index + 1}`,
    x: x + (index % grid) * (width + gap),
    y: y + Math.floor(index / grid) * (height + gap),
    width,
    height,
    naturalWidth: tile.width,
    naturalHeight: tile.height,
  }))
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    for (const item of items) {
      insertCanvasNode(
        canvas.doc,
        { id: item.id, type: 'image', x: item.x, y: item.y, width, height, data: {} },
        canvas.origin,
      )
      connectCanvasNodes(canvas.doc, { source: sourceId, target: item.id }, canvas.origin)
    }
    const previous = editor.doc.elements
    editor.placeImages(items)
    synchronizeLegacyElements(canvas.doc, previous, editor.doc.elements, canvas.origin)
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return items.map((item) => item.id)
}
