import type { Box, Editor } from 'tldraw'
import { bytesToDataUrl } from '../../../lib/imageApiShared'

export interface RasterizedSelection {
  /** 选区内**每张图片各自**栅格化的 PNG dataUrl（决策 5：独立多图，不拼合）。 */
  dataUrls: string[]
  /** 选区在画布页面坐标系下的包围盒，用于把生成结果放到选区右侧。 */
  bounds: Box
}

/**
 * 把当前选中的**图片** shape 各自栅格化成独立 PNG（决策 5）。
 * 只取图片 shape，非图片元素不进入输入（spec：非图片 shape 不作为图像输入）。
 * 返回 null 表示选区里没有图片。背景填不透明白底，避免上游模型收到透明通道。
 * 多张图片各自独立 → 并行栅格化。用 bytesToDataUrl（chunked btoa，避免大图 stack overflow）。
 */
export async function rasterizeSelection(editor: Editor): Promise<RasterizedSelection | null> {
  const ids = editor.getSelectedShapeIds()
  if (ids.length === 0) return null
  const bounds = editor.getSelectionPageBounds()
  if (!bounds) return null

  const imageIds = ids.filter((id) => editor.getShape(id)?.type === 'image')
  if (imageIds.length === 0) return null

  const rasterized = await Promise.all(
    imageIds.map(async (id) => {
      const result = await editor.toImage([id], {
        format: 'png',
        background: true,
        padding: 0,
        scale: 1,
      })
      if (!result?.blob) return null
      return bytesToDataUrl(await result.blob.arrayBuffer(), result.blob.type || 'image/png')
    }),
  )
  const dataUrls = rasterized.filter((url): url is string => url !== null)
  if (dataUrls.length === 0) return null

  return { dataUrls, bounds }
}
