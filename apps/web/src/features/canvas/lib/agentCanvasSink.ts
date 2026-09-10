import type {
  AgentCanvasSink,
  AgentPlacedImage,
  AgentPlaceOutcome,
} from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { placeImagesOnCanvas } from './placeholderShapeOps'
import { computePlaceholderTarget } from './placement'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

export function createAgentCanvasSink(editor: CanvasEditor): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()

  return {
    has: (imageId) => editor.getElement(imageId) !== undefined,

    revision: () => editor.contentRevision(),

    async place(
      images: readonly AgentPlacedImage[],
      baseRevision?: number,
    ): Promise<AgentPlaceOutcome> {
      if (baseRevision !== undefined && editor.contentRevision() !== baseRevision) return 'conflict'
      await placeImagesOnCanvas(
        editor,
        images.map((image) => image.dataUrl),
        computePlaceholderTarget(editor, null),
        { ids: images.map((image) => image.imageId) },
      )
      return 'placed'
    },

    focus(imageId) {
      if (!editor.getElement(imageId)) return
      editor.setSelectedElements([imageId])
      editor.scrollToElements([imageId])
    },

    async thumbnail(imageId) {
      const cached = thumbnails.get(imageId)
      if (cached) return cached
      const rendered = await editor.toImage([imageId], { scale: THUMBNAIL_SCALE })
      if (rendered) thumbnails.set(imageId, rendered)
      return rendered
    },
  }
}
