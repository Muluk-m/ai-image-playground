import {
  type CanvasResult,
  type CanvasSnapshot,
  canvasInputFingerprint,
  canvasMainResult,
  canvasOrigin,
  canvasResultIsStale,
  chooseCanvasResult,
  readCanvasDocument,
  storyboardFingerprint,
} from '@image-playground/shared'
import { useEffect } from 'react'
import { i18next } from '../../../i18n'
import { accountScope } from '../../../lib/authScope'
import { canvasToBlob, loadImage } from '../../../lib/canvasImage'
import { blobDataUrl, resolveMediaSource } from '../../../lib/cloudMedia'
import { useStore } from '../../../store'
import type { CanvasEditor } from './editor'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { recordNodeOutput } from './nodeCanvasResults'
import { patchStoryboardMedia, STORYBOARD_GRID_MAX } from '@image-playground/shared'

const origin = canvasOrigin('system', 'storyboard-grid')
export function storyboardTiles(
  width: number,
  height: number,
  rows: number,
  columns: number,
  count: number,
) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows * columns > STORYBOARD_GRID_MAX ||
    count > rows * columns ||
    width < columns ||
    height < rows
  )
    throw new Error('Invalid storyboard grid')
  return Array.from({ length: count }, (_, index) => {
    const col = index % columns,
      row = Math.floor(index / columns)
    const x = Math.floor((width * col) / columns),
      y = Math.floor((height * row) / rows)
    return {
      x,
      y,
      width: Math.floor((width * (col + 1)) / columns) - x,
      height: Math.floor((height * (row + 1)) / rows) - y,
    }
  })
}
function splitInfo(
  canvas: NodeCanvasDocument,
  id: string,
  snapshot: CanvasSnapshot = readCanvasDocument(canvas.doc),
) {
  const grid = snapshot.nodes.find((node) => node.id === id)
  if (grid?.type !== 'image' || grid.data.meta?.storyboardRole !== 'grid') return
  const meta = grid.data.meta,
    board = snapshot.nodes.find((node) => node.id === meta.storyboardId)
  const result = canvasMainResult(canvas.doc, id)
  if (
    board?.type !== 'storyboard' ||
    !result ||
    !grid.data.fileId ||
    meta.storyboardSplitResult === result.id ||
    canvasResultIsStale(canvas.doc, id) ||
    storyboardFingerprint(board.data.shots) !== meta.storyboardFingerprint
  )
    return
  try {
    const frameIds: unknown = JSON.parse(meta.storyboardFrameIds ?? 'null'),
      layout = JSON.parse(meta.storyboardGrid ?? 'null')
    if (
      !Array.isArray(frameIds) ||
      !frameIds.length ||
      frameIds.length > STORYBOARD_GRID_MAX ||
      new Set(frameIds).size !== frameIds.length ||
      !frameIds.every((id) => typeof id === 'string')
    )
      return
    const frames = frameIds.map((id) => snapshot.nodes.find((node) => node.id === id))
    if (
      frames.some(
        (node) =>
          node?.type !== 'image' ||
          node.data.meta?.storyboardId !== board.id ||
          !board.data.shots.some((shot) => shot.id === node.data.meta?.storyboardShotId),
      )
    )
      return
    if (!layout || !Number.isInteger(layout.rows) || !Number.isInteger(layout.columns)) return
    return {
      grid,
      result,
      frameIds: frameIds as string[],
      layout: layout as { rows: number; columns: number },
    }
  } catch {
    return
  }
}
export async function splitStoryboardGrid(
  canvas: NodeCanvasDocument,
  editor: CanvasEditor,
  id: string,
) {
  const start = splitInfo(canvas, id)
  if (!start) return false
  const source = editor.doc.files[start.grid.data.fileId!]
  if (!source) return false
  const sameAccount = accountScope()
  let baseline: unknown, previousCuts: unknown, fingerprints: unknown
  try {
    baseline = JSON.parse(start.grid.data.meta?.storyboardFrameBaseline ?? '[]')
    previousCuts = JSON.parse(start.grid.data.meta?.storyboardSplitFrames ?? '[]')
    fingerprints = JSON.parse(start.grid.data.meta?.storyboardFrameInputs ?? '[]')
  } catch {
    return false
  }
  if (
    !Array.isArray(fingerprints) ||
    fingerprints.length !== start.frameIds.length ||
    !fingerprints.every((value) => typeof value === 'string')
  )
    return false
  const frameInputs: string[] = fingerprints
  const initialMain = start.frameIds.map((id, index) => {
    const main = canvasMainResult(canvas.doc, id)
    const fromPreviousGrid = Array.isArray(previousCuts) && previousCuts[index] === main?.id
    const expected = Array.isArray(baseline) ? baseline[index] : null
    return !main || main.id === expected || fromPreviousGrid ? (main?.id ?? null) : false
  })
  const valid = () => {
    if (!sameAccount() || canvas.doc.isDestroyed) return false
    const current = splitInfo(canvas, id)
    return (
      current?.result.id === start.result.id &&
      JSON.stringify(current.frameIds) === JSON.stringify(start.frameIds)
    )
  }
  const image = await loadImage(await resolveMediaSource(source, 'original', true))
  const tiles = storyboardTiles(
    image.naturalWidth,
    image.naturalHeight,
    start.layout.rows,
    start.layout.columns,
    start.frameIds.length,
  )
  const outputs: {
    result: CanvasResult
    fileId: string
    tile: ReturnType<typeof storyboardTiles>[number]
  }[] = []
  for (const [index, tile] of tiles.entries()) {
    if (!valid()) return false
    const layer = document.createElement('canvas')
    layer.width = tile.width
    layer.height = tile.height
    const ctx = layer.getContext('2d')
    if (!ctx) throw new Error('Canvas unavailable')
    ctx.drawImage(image, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height)
    const dataUrl = await blobDataUrl(await canvasToBlob(layer))
    layer.width = layer.height = 0
    if (!valid()) return false
    const fileId = editor.doc.cacheBitmap(dataUrl, `story-grid:${start.result.id}:${index}`)
    const result = await recordNodeOutput(
      canvas.doc,
      {
        nodeId: start.frameIds[index]!,
        kind: 'image',
        createdAt: Date.now() + index,
        source: { type: 'file', fileId },
        inputFingerprint: frameInputs[index],
      },
      dataUrl,
    )
    if (!result) return false
    outputs.push({ result, fileId, tile })
  }
  if (!valid()) return false
  canvas.doc.transact(() => {
    for (const [index, { result, fileId, tile }] of outputs.entries()) {
      if (
        initialMain[index] === false ||
        (canvasMainResult(canvas.doc, result.nodeId)?.id ?? null) !== initialMain[index] ||
        canvasInputFingerprint(canvas.doc, result.nodeId) !== frameInputs[index]
      )
        continue
      chooseCanvasResult(
        canvas.doc,
        result.nodeId,
        result.id,
        {
          data: { fileId, naturalWidth: tile.width, naturalHeight: tile.height },
        },
        origin,
      )
    }
    patchStoryboardMedia(
      canvas.doc,
      id,
      {
        meta: {
          storyboardSplitResult: start.result.id,
          storyboardSplitFrames: JSON.stringify(outputs.map((output) => output.result.id)),
        },
      },
      origin,
    )
  }, origin)
  return true
}
/** Result-driven: closing a generation dialog or reloading does not lose the pending split. */
export function useStoryboardGridSplitting(canvas: NodeCanvasDocument, editor: CanvasEditor) {
  useEffect(() => {
    const running = new Set<string>(),
      failed = new Set<string>()
    let alive = true
    const check = () => {
      if (!alive || canvas.doc.isDestroyed) return
      const snapshot = readCanvasDocument(canvas.doc)
      for (const node of snapshot.nodes) {
        if (node.type !== 'image' || node.data.meta?.storyboardRole !== 'grid') continue
        const info = splitInfo(canvas, node.id, snapshot)
        if (
          !info ||
          running.has(node.id) ||
          failed.has(info.result.id) ||
          !editor.doc.files[info.grid.data.fileId!]
        )
          continue
        running.add(node.id)
        void splitStoryboardGrid(canvas, editor, node.id)
          .catch(() => {
            failed.add(info.result.id)
            if (alive)
              useStore
                .getState()
                .showToast(i18next.getFixedT(null, 'canvas')('storyFlow.splitFailed'), 'error')
          })
          .finally(() => {
            running.delete(node.id)
            // An adopted replacement may arrive while the previous sheet is decoding.
            const current = splitInfo(canvas, node.id)
            if (current && current.result.id !== info.result.id) check()
          })
      }
    }
    canvas.doc.on('update', check)
    const unsubscribe = editor.doc.subscribe(check)
    check()
    return () => {
      alive = false
      canvas.doc.off('update', check)
      unsubscribe()
    }
  }, [canvas, editor])
}
