import {
  connectCanvasNodes,
  readCanvasDocument,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import type { CanvasEl } from './canvasDoc'
import { captureCanvasVideoFrame } from './canvasVideoActions'
import type { CanvasEditor } from './editor'
import { createNode } from './nodeCanvasActions'
import type { NodeCanvasDocument } from './nodeCanvasDocument'

export async function extractNodeVideoFrame(
  editor: CanvasEditor,
  canvas: NodeCanvasDocument,
  sourceId: string,
  which: 'first' | 'last' | 'current',
  currentTime = 0,
): Promise<string | null> {
  const original = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === sourceId)
  if (original?.type !== 'video') return null
  const frame = await captureCanvasVideoFrame(
    original.data.video,
    which === 'current' ? currentTime : which,
  )
  if (!frame) throw new Error('Unable to decode video frame')
  if (canvas.doc.isDestroyed) return null
  const source = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === sourceId)
  if (
    source?.type !== 'video' ||
    JSON.stringify(source.data.video) !== JSON.stringify(original.data.video)
  )
    return null
  let id = ''
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    id = createNode(canvas, 'image', { x: source.x, y: source.y }, '', {
      nodes: [source],
      side: 'right',
      size: { width: 360, height: (360 * source.height) / source.width },
    })
    const node = readCanvasDocument(canvas.doc).nodes.find((n) => n.id === id)!
    const previous = editor.doc.elements
    editor.placeImages(
      [
        {
          id,
          dataUrl: frame,
          x: node.x,
          y: node.y,
          width: node.width,
          height: (node.width * source.height) / source.width,
        },
      ],
      { frameOf: sourceId, frame: which },
    )
    synchronizeLegacyElements(canvas.doc, previous, editor.doc.elements, canvas.origin)
    connectCanvasNodes(canvas.doc, { source: sourceId, target: id }, canvas.origin)
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return id
}

/** Keep timeline references in source seconds; trimming is one reversible document edit. */
export function trimNodeVideo(
  canvas: NodeCanvasDocument,
  id: string,
  start: number,
  end: number,
  duration: number,
): boolean {
  if (
    ![start, end, duration].every(Number.isFinite) ||
    start < 0 ||
    end > duration ||
    end - start < 0.1
  )
    return false
  const snapshot = readCanvasDocument(canvas.doc)
  const node = snapshot.nodes.find((n) => n.id === id)
  if (node?.type !== 'video') return false
  canvas.undo.stopCapturing()
  canvas.doc.transact(() => {
    updateCanvasNode(
      canvas.doc,
      id,
      {
        data: {
          ...node.data,
          meta: { ...node.data.meta, videoTrimIn: String(start), videoTrimOut: String(end) },
        },
      },
      canvas.origin,
    )
    for (const timeline of snapshot.nodes) {
      if (timeline.type !== 'timeline' || !timeline.data.clips.some((c) => c.elementId === id))
        continue
      const clips = timeline.data.clips.map((clip) => {
        if (clip.elementId !== id) return clip
        const from = Math.max(start, clip.in)
        const to = Math.min(end, clip.out ?? duration)
        return { ...clip, in: to - from >= 0.1 ? from : start, out: to - from >= 0.1 ? to : end }
      })
      updateCanvasNode(canvas.doc, timeline.id, { data: { clips } }, canvas.origin)
    }
  }, canvas.origin)
  canvas.undo.stopCapturing()
  return true
}

/** Reflect video edits into remaining local timeline tools without making a second undo history. */
export function projectNodeVideoEdits(editor: CanvasEditor, canvas: NodeCanvasDocument): void {
  const patches = readCanvasDocument(canvas.doc).nodes.flatMap<{
    id: string
    patch: Partial<CanvasEl>
  }>((node) => {
    const element = editor.doc.elements.find((element) => element.id === node.id)
    if (node.type === 'video' && element?.type === 'image') {
      const patch = {
        ...node.data,
        meta: node.data.meta ?? {},
        fileId: node.data.fileId ?? element.fileId,
        rotation: node.data.rotation ?? 0,
      }
      if (
        Object.entries(patch).some(
          ([key, value]) =>
            JSON.stringify(element[key as keyof typeof element]) !== JSON.stringify(value),
        )
      )
        return [{ id: node.id, patch }]
    }
    if (
      node.type === 'timeline' &&
      element?.type === 'timeline' &&
      JSON.stringify(element.clips) !== JSON.stringify(node.data.clips)
    )
      return [{ id: node.id, patch: { clips: node.data.clips } }]
    return []
  })
  editor.doc.updateElements(patches)
}
