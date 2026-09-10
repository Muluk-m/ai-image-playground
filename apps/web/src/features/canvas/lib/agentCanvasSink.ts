import type { AgentCanvasSink, AgentPlacedImage } from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { placeImagesOnCanvas } from './placeholderShapeOps'
import { computePlaceholderTarget } from './placement'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

/** 智能体产出落画布的实现。产出的画布对象 id 就是结果卡上的 `imageId`。 */
export function createAgentCanvasSink(editor: CanvasEditor): AgentCanvasSink {
  return {
    has: (imageId) => editor.getElement(imageId) !== undefined,

    async place(images: readonly AgentPlacedImage[]) {
      await placeImagesOnCanvas(
        editor,
        images.map((image) => image.dataUrl),
        computePlaceholderTarget(editor, null),
        { ids: images.map((image) => image.imageId) },
      )
    },

    focus(imageId) {
      if (!editor.getElement(imageId)) return
      editor.setSelectedElements([imageId])
      editor.scrollToElements([imageId])
    },

    thumbnail: (imageId) => editor.toImage([imageId], { scale: THUMBNAIL_SCALE }),
  }
}
