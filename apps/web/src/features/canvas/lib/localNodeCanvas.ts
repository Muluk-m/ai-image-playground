import {
  canvasOrigin,
  type LegacyCanvasElement,
  reconcileLegacyElements,
  synchronizeLegacyElements,
} from '@image-playground/shared'
import type { CanvasEditor } from './editor'
import { type NodeCanvasDocument, openNodeCanvasDocument } from './nodeCanvasDocument'
import { resumeNodeGenerations } from './nodeCanvasGenerate'
import { resumeNodeVideos } from './nodeCanvasVideo'
import { projectNodeVideoEdits } from './nodeVideoTools'

const legacyOrigin = canvasOrigin('system', 'legacy-update')

/** 本机画布随显示期间打开：取消后停止桥接，等尚未完成的打开落定再关闭文档。 */
export async function openLocalNodeCanvas(
  sceneKey: string,
  editor: CanvasEditor,
  signal: AbortSignal,
): Promise<NodeCanvasDocument | null> {
  if (signal.aborted) return null
  let opened: NodeCanvasDocument | undefined
  let projecting = false
  const projectEdits = () => {
    if (!opened || signal.aborted) return
    projecting = true
    try {
      projectNodeVideoEdits(editor, opened)
    } finally {
      projecting = false
    }
  }
  let previous = editor.doc.elements as readonly LegacyCanvasElement[]
  const queued: Array<readonly [readonly LegacyCanvasElement[], readonly LegacyCanvasElement[]]> =
    []
  const unsubscribe = editor.doc.subscribe(() => {
    const next = editor.doc.elements as readonly LegacyCanvasElement[]
    if (opened && !signal.aborted && !projecting)
      synchronizeLegacyElements(opened.doc, previous, next, legacyOrigin)
    else if (!opened && !signal.aborted && previous !== next) queued.push([previous, next])
    previous = next
  })
  const close = () => {
    unsubscribe()
    opened?.doc.off('update', projectEdits)
    void opened?.destroy()
  }
  signal.addEventListener('abort', close, { once: true })
  const canvas = await openNodeCanvasDocument(
    sceneKey,
    () => editor.doc.elements as readonly LegacyCanvasElement[],
  )
  if (signal.aborted) {
    await canvas.destroy()
    return null
  }
  opened = canvas
  reconcileLegacyElements(canvas.doc, previous, legacyOrigin)
  // 迁移可能读过中间状态；净差异为零的「添加后撤销」仍要逐次重放。
  for (const [before, after] of queued)
    synchronizeLegacyElements(canvas.doc, before, after, legacyOrigin)
  queued.length = 0
  canvas.doc.on('update', projectEdits)
  projectEdits()
  resumeNodeGenerations(editor, canvas.doc)
  resumeNodeVideos(editor, canvas.doc)
  return canvas
}
