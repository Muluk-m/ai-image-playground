import type { AgentCanvasSink } from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { placeImagesOnCanvas } from './placeholderShapeOps'
import { computePlaceholderTarget } from './placement'
import { videoElementMeta } from './videoElements'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

export function createAgentCanvasSink(editor: CanvasEditor): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()

  return {
    has: (objectId) => editor.getElement(objectId) !== undefined,

    revision: () => editor.editRevision(),

    async place(artifacts, options) {
      const base = options?.baseRevision
      if (base !== undefined && editor.editRevision() !== base) return 'conflict'
      const anchor = options?.anchorImageId
      const bounds = anchor ? (editor.getElementPageBounds(anchor) ?? null) : null
      await placeImagesOnCanvas(
        editor,
        artifacts.map((artifact) => artifact.dataUrl),
        computePlaceholderTarget(editor, bounds),
        {
          ids: artifacts.map((artifact) => artifact.artifactId),
          metas: artifacts.map((artifact) =>
            artifact.video ? videoElementMeta(artifact.video) : undefined,
          ),
        },
      )
      return 'placed'
    },

    focus(objectId) {
      if (!editor.getElement(objectId)) return
      editor.setSelectedElements([objectId])
      editor.scrollToElements([objectId])
    },

    async thumbnail(objectId) {
      const cached = thumbnails.get(objectId)
      if (cached) return cached
      const rendered = await editor.toImage([objectId], { scale: THUMBNAIL_SCALE })
      if (rendered) thumbnails.set(objectId, rendered)
      return rendered
    },
  }
}
