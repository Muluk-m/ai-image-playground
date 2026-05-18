import { ensureImageCached, getCachedImage } from '../store'

export interface DownloadResult {
  success: number
  failed: number
}

/**
 * 按 imageId 顺序下载到本地。InputBar 批量下载和 TaskCard 单卡下载共用，
 * 不在 helper 里发 toast，由调用方按场景文案自定义。
 *
 * 100ms 间歇是为了让浏览器把每次 a.click() 当成独立用户动作，否则连续触发
 * 部分浏览器只会保留最后一次下载。
 */
export async function downloadImagesByIds(
  ids: readonly string[],
  filenamePrefix = 'image',
): Promise<DownloadResult> {
  let success = 0
  let failed = 0
  for (const id of ids) {
    try {
      const url = getCachedImage(id) ?? (await ensureImageCached(id))
      if (!url) {
        failed++
        continue
      }
      const res = await fetch(url)
      const blob = await res.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      const ext = blob.type.split('/')[1] || 'png'
      a.download = `${filenamePrefix}-${Date.now()}-${success}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(objUrl)
      success++
      await new Promise((r) => setTimeout(r, 100))
    } catch (err) {
      console.error(err)
      failed++
    }
  }
  return { success, failed }
}
