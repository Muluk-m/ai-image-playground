import { getImageDimensions } from '../../../lib/canvasImage'
import type { CanvasEditor } from './editor'
import { PLACEMENT_GAP } from './placement'

/**
 * 外部图片导入画布（文件拖入 / 剪贴板粘贴共用）。
 * 展示尺寸夹到最长边 ≤ MAX_SIDE（页面单位）——太大的原图铺满画布没法操作；
 * dataUrl 保留原始分辨率，随场景持久化。
 */
const MAX_SIDE = 720

function fileToDataUrl(file: File): Promise<string> {
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

  const entries = await Promise.all(
    imageFiles.map(async (file) => {
      const dataUrl = await fileToDataUrl(file)
      const { width, height } = await getImageDimensions(dataUrl)
      const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
      return { dataUrl, width: width * scale, height: height * scale }
    }),
  )

  const totalW = entries.reduce((sum, e) => sum + e.width, 0) + PLACEMENT_GAP * (entries.length - 1)
  let x = center.x - totalW / 2
  const items = entries.map((e) => {
    const item = {
      dataUrl: e.dataUrl,
      x,
      y: center.y - e.height / 2,
      width: e.width,
      height: e.height,
    }
    x += e.width + PLACEMENT_GAP
    return item
  })

  const ids = editor.placeImages(items)
  editor.setSelectedElements(ids)
  return items.length
}
