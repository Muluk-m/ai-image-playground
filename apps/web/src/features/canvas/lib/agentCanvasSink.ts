import type { AgentCanvasSink, AgentPlaceOutcome } from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { placeImagesOnCanvas } from './placeholderShapeOps'
import { computePlaceholderTarget } from './placement'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

export function createAgentCanvasSink(
  editor: CanvasEditor,
  ready?: Promise<unknown>,
): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()

  return {
    ready,
    has: (objectId) => editor.getElement(objectId) !== undefined,

    revision: () => editor.editRevision(),

    async place(artifacts, options) {
      if (ready) await ready
      let outcome: AgentPlaceOutcome = 'placed'
      const canPlace = () => {
        const base = options?.baseRevision
        outcome =
          options?.isCurrent && !options.isCurrent()
            ? 'unavailable'
            : base !== undefined && editor.editRevision() !== base
              ? 'conflict'
              : 'placed'
        return outcome === 'placed'
      }
      if (!canPlace()) return outcome
      const missing = artifacts.filter((artifact) => !editor.getElement(artifact.artifactId))
      if (missing.length === 0) return 'placed'
      const anchor = options?.anchorObjectId
      const bounds = anchor ? (editor.getElementPageBounds(anchor) ?? null) : null
      await placeImagesOnCanvas(
        editor,
        missing.map((artifact) => ({
          dataUrl: artifact.dataUrl,
          id: artifact.artifactId,
          ...(artifact.video ? { video: artifact.video } : {}),
        })),
        computePlaceholderTarget(editor, bounds),
        { canPlace },
      )
      return outcome
    },

    focus(objectId) {
      if (!editor.getElement(objectId)) return
      editor.setSelectedElements([objectId])
      editor.scrollToElements([objectId])
    },

    async thumbnail(objectId) {
      if (ready) await ready
      const cached = thumbnails.get(objectId)
      if (cached) return cached
      const rendered = await editor.toImage([objectId], { scale: THUMBNAIL_SCALE })
      if (rendered) thumbnails.set(objectId, rendered)
      return rendered
    },
  }
}
