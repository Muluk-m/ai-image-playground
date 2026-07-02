import {
  Box,
  type Editor,
  renderPlaintextFromRichText,
  type TLRichText,
  type TLShapeId,
} from 'tldraw'
import { bytesToDataUrl } from '../../../lib/imageApiShared'

export interface RasterizedSelection {
  /**
   * 喂给模型的参考图 dataUrl 列表：
   * - 标注模式（annotated=true）：**以图片范围为裁剪框**、图片连同画在其上的图形标注（圈/箭头等）
   *   合成的单张（游离到图片外的标注被裁掉，文字标注不入图）
   * - 多图模式（annotated=false）：选区内每张图片**各自独立**的栅格图（决策 5，不拼合）
   */
  dataUrls: string[]
  /** 图片的联合包围盒（页面坐标）：结果放置基准 + 标注模式的裁剪范围。 */
  bounds: Box
  /** 选区是否含手绘标注（图形标注或文字标注）。 */
  annotated: boolean
  /** 从文字标注（text / 带 richText 的 shape）提取的纯文本，拼进 prompt 当修改指令。 */
  annotationText: string
}

const TO_IMAGE_OPTS = { format: 'png', background: true, padding: 0, scale: 1 } as const

async function toDataUrl(
  editor: Editor,
  ids: TLShapeId[],
  extra?: { bounds?: Box },
): Promise<string | null> {
  const result = await editor.toImage(ids, { ...TO_IMAGE_OPTS, ...extra })
  if (!result?.blob) return null
  return bytesToDataUrl(await result.blob.arrayBuffer(), result.blob.type || 'image/png')
}

function getRichText(shape: { props?: unknown } | undefined): TLRichText | undefined {
  const props = shape?.props as { richText?: TLRichText } | undefined
  return props?.richText
}

/**
 * 把当前选区栅格化为模型参考图，按选区内容分流：
 * - 选区纯图片 → **多图模式**：每张图片各自 `toImage([id])` 独立栅格化（决策 5，不拼合），并行。
 * - 选区含手绘标注（图形 / 文字等非图片 shape）+ 至少一张图片 → **标注模式**：
 *   - **文字标注**（text / 带 richText 的 shape）抽成 `annotationText` 进 prompt，**不画进图**；
 *   - 图像 = 以图片包围盒为裁剪框，图片连同画在其上的图形标注（圈/箭头）合成单张，
 *     游离到图片外的部分被裁掉（避免把大片画布空白和远处标注拉进图误导模型）。
 * - 无图片（空选区 / 纯标注）→ 返回 null（无有效图像输入，上层走文生图）。
 *
 * 背景填不透明白底，避免上游模型收到透明通道。用 bytesToDataUrl（chunked btoa，避免大图 stack overflow）。
 */
export async function rasterizeSelection(editor: Editor): Promise<RasterizedSelection | null> {
  const ids = editor.getSelectedShapeIds()
  if (ids.length === 0) return null

  const imageIds = ids.filter((id) => editor.getShape(id)?.type === 'image')
  if (imageIds.length === 0) return null

  // 图片联合包围盒：结果放置基准 + 标注模式裁剪范围。
  const imageBoxes = imageIds
    .map((id) => editor.getShapePageBounds(id))
    .filter((b): b is Box => b !== undefined)
  if (imageBoxes.length === 0) return null
  const bounds = Box.Common(imageBoxes)

  // 非图片 shape = 标注：文字类抽成 prompt 文本，图形类随图片一起栅格化。
  const annotationIds = ids.filter((id) => editor.getShape(id)?.type !== 'image')
  const textParts: string[] = []
  const graphicIds: TLShapeId[] = []
  for (const id of annotationIds) {
    const shape = editor.getShape(id)
    if (!shape) continue
    const richText = getRichText(shape)
    const text = richText ? renderPlaintextFromRichText(editor, richText).trim() : ''
    if (text) textParts.push(text)
    // text shape 内容已抽为文本，本身不画进图；其余图形标注（圈/箭头/draw）画进图。
    if (shape.type !== 'text') graphicIds.push(id)
  }
  const annotationText = textParts.join('\n')

  if (annotationIds.length === 0) {
    // 多图模式：每张图片各自独立栅格化。
    const rasterized = await Promise.all(imageIds.map((id) => toDataUrl(editor, [id])))
    const dataUrls = rasterized.filter((url): url is string => url !== null)
    if (dataUrls.length === 0) return null
    return { dataUrls, bounds, annotated: false, annotationText: '' }
  }

  // 标注模式：以图片包围盒为裁剪框，图片 + 图形标注合成单张。
  const dataUrl = await toDataUrl(editor, [...imageIds, ...graphicIds], { bounds })
  if (!dataUrl) return null
  return { dataUrls: [dataUrl], bounds, annotated: true, annotationText }
}
