import { getImageDimensions } from '../../../lib/canvasImage'
import type { CanvasEditor } from './editor'
import { PLACEMENT_GAP } from './placement'

/**
 * 外部图片导入画布（文件拖入 / 剪贴板粘贴共用）。
 * 展示尺寸夹到最长边 ≤ MAX_SIDE（页面单位）——太大的原图铺满画布没法操作；
 * dataUrl 保留原始分辨率，随场景持久化。
 */
const MAX_SIDE = 720

/** File → dataURL。画布导入与局部重绘面板的参考图上传共用，避免两处各写一份 FileReader。 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * 把一组图片文件放到画布：以 center 为中心横排展开、彼此留间距，放置后选中。
 * 非图片文件被忽略；返回实际放入的张数（0 表示没有可导入的图片）。
 */
export async function importImageFiles(
  editor: CanvasEditor,
  files: File[],
  center: { x: number; y: number },
): Promise<number> {
  const imageFiles = files.filter((f) => f.type.startsWith('image/'))
  if (imageFiles.length === 0) return 0

  // 逐个容错：一张损坏/解码失败的图不拖垮整批（其余照常导入）
  const results = await Promise.allSettled(
    imageFiles.map(async (file) => {
      const dataUrl = await fileToDataUrl(file)
      const { width, height } = await getImageDimensions(dataUrl)
      const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
      return {
        dataUrl,
        width: width * scale,
        height: height * scale,
        name: file.name,
        naturalWidth: width,
        naturalHeight: height,
      }
    }),
  )
  for (const r of results) {
    if (r.status === 'rejected')
      console.warn('[canvas] skipped an image that failed to import', r.reason)
  }
  const entries = results
    .filter(
      (
        r,
      ): r is PromiseFulfilledResult<{
        dataUrl: string
        width: number
        height: number
        name: string
        naturalWidth: number
        naturalHeight: number
      }> => r.status === 'fulfilled',
    )
    .map((r) => r.value)
  if (entries.length === 0) return 0

  // 拖一个文件夹进来可能是几十张：排成一行会拉出一条几万像素长的带子，谁都看不过来。
  // 按接近正方形的网格铺，行高取该行最高的一张。
  const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length)))
  const rows: (typeof entries)[] = []
  for (let i = 0; i < entries.length; i += columns) rows.push(entries.slice(i, i + columns))
  const rowHeights = rows.map((row) => Math.max(...row.map((e) => e.height)))
  const totalH = rowHeights.reduce((sum, h) => sum + h, 0) + PLACEMENT_GAP * (rowHeights.length - 1)

  const items: Array<{
    dataUrl: string
    x: number
    y: number
    width: number
    height: number
    name: string
    naturalWidth: number
    naturalHeight: number
  }> = []
  let y = center.y - totalH / 2
  rows.forEach((row, rowIndex) => {
    const rowWidth = row.reduce((sum, e) => sum + e.width, 0) + PLACEMENT_GAP * (row.length - 1)
    let x = center.x - rowWidth / 2
    const rowHeight = rowHeights[rowIndex]!
    for (const e of row) {
      items.push({
        dataUrl: e.dataUrl,
        x,
        // 同一行按中线对齐：高矮不一的图顶着上沿排会像被踢乱了。
        y: y + (rowHeight - e.height) / 2,
        width: e.width,
        height: e.height,
        name: e.name,
        naturalWidth: e.naturalWidth,
        naturalHeight: e.naturalHeight,
      })
      x += e.width + PLACEMENT_GAP
    }
    y += rowHeight + PLACEMENT_GAP
  })

  const ids = editor.placeImages(items)
  editor.setSelectedElements(ids)
  return items.length
}
