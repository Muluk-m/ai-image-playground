import type { Box, Editor } from 'tldraw'
import { bytesToDataUrl } from '../../../lib/imageApiShared'

export interface RasterizedSelection {
  /**
   * 喂给模型的参考图 dataUrl 列表：
   * - 标注模式（annotated=true）：图片 + 手绘标注**合成的单张**参考图
   * - 多图模式（annotated=false）：选区内每张图片**各自独立**的栅格图（决策 5，不拼合）
   */
  dataUrls: string[]
  /** 选区在画布页面坐标系下的包围盒，用于把生成结果放到选区右侧。 */
  bounds: Box
  /**
   * 选区是否含手绘标注（圈选 / 箭头 / 文字等非图片 shape）。为 true 时上层需注入
   * 「按标注改、输出干净图」指令；此时 dataUrls 是图片+标注合成的单张。
   */
  annotated: boolean
}

const TO_IMAGE_OPTS = { format: 'png', background: true, padding: 0, scale: 1 } as const

async function toDataUrl(editor: Editor, ids: readonly string[]): Promise<string | null> {
  const result = await editor.toImage(ids as never, TO_IMAGE_OPTS)
  if (!result?.blob) return null
  return bytesToDataUrl(await result.blob.arrayBuffer(), result.blob.type || 'image/png')
}

/**
 * 把当前选区栅格化为模型参考图，按选区内容分流：
 * - 选区含手绘标注（有非图片 shape）+ 至少一张图片 → **合成模式**：图片连同其上标注一起
 *   `toImage(全部选中 ids)` 合成单张（cowork.art 式「在图上画一笔再迭代」）。
 * - 选区纯图片 → **多图模式**：每张图片各自 `toImage([id])` 独立栅格化（决策 5，不拼合），并行。
 * - 无图片（空选区 / 纯标注）→ 返回 null（无有效图像输入，上层走文生图）。
 *
 * 背景填不透明白底，避免上游模型收到透明通道。用 bytesToDataUrl（chunked btoa，避免大图 stack overflow）。
 */
export async function rasterizeSelection(editor: Editor): Promise<RasterizedSelection | null> {
  const ids = editor.getSelectedShapeIds()
  if (ids.length === 0) return null
  const bounds = editor.getSelectionPageBounds()
  if (!bounds) return null

  const imageIds = ids.filter((id) => editor.getShape(id)?.type === 'image')
  if (imageIds.length === 0) return null

  const annotated = ids.length > imageIds.length

  if (annotated) {
    // 合成模式：图片 + 标注一起栅格化为单张参考图。
    const dataUrl = await toDataUrl(editor, ids)
    if (!dataUrl) return null
    return { dataUrls: [dataUrl], bounds, annotated: true }
  }

  // 多图模式：每张图片各自独立栅格化。
  const rasterized = await Promise.all(imageIds.map((id) => toDataUrl(editor, [id])))
  const dataUrls = rasterized.filter((url): url is string => url !== null)
  if (dataUrls.length === 0) return null

  return { dataUrls, bounds, annotated: false }
}
