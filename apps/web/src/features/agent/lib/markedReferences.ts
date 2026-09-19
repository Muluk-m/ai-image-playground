import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import { elementBounds } from '../../canvas/lib/editor'
import type { Box } from '../../canvas/lib/geometry'

const MARK_TYPES = new Set(['freedraw', 'arrow', 'text'])

/** 选区里压在这张图上的批注（画笔 / 箭头 / 文字）：用户圈出来的就是要说的那块。 */
export function selectedMarkIds(doc: CanvasDoc, image: ImageEl): string[] {
  const bounds = elementBounds(image)
  return doc.elements
    .filter(
      (el) =>
        doc.selection.has(el.id) && MARK_TYPES.has(el.type) && elementBounds(el).collides(bounds),
    )
    .map((el) => el.id)
}

export interface MarkRenderer {
  toImage(ids: string[], opts: { bounds: Box }): Promise<string | null>
}

/**
 * 把批注烧进图里作为参考图：模型看到的就是画布上那张带红圈的图，裁到图片自己的边界，
 * 超出图片的笔画不带。id 仍是画布对象 id，模型改图时照旧指认这一张。
 */
export function renderMarkedImage(
  renderer: MarkRenderer,
  image: ImageEl,
  markIds: readonly string[],
): Promise<string | null> {
  return renderer.toImage([image.id, ...markIds], { bounds: elementBounds(image) })
}
