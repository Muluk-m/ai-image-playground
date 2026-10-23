import { getDeviceId } from '../../../lib/deviceId'

const KEY = 'canvas-uploader-tab'
let uploader: string | undefined

/**
 * 写上传声明用的「上传者」：设备 ID 再加本标签页的随机后缀。同一浏览器的另一个标签页内存里没有这张原图，
 * 要把它当成别处在传。后缀存在 sessionStorage 里：刷新本标签页后仍认得自己写的声明，接着传；
 * 存不了（隐私模式等）时退回只在内存里。
 */
export function getCanvasUploaderId(): string {
  if (uploader) return uploader
  let tab: string | null = null
  try {
    tab = sessionStorage.getItem(KEY)
  } catch {}
  if (!tab || !/^[\w-]{1,32}$/.test(tab)) {
    tab = crypto.randomUUID().slice(0, 8)
    try {
      sessionStorage.setItem(KEY, tab)
    } catch {}
  }
  uploader = `${getDeviceId()}:${tab}`
  return uploader
}
