import { getDeviceId } from '../../../lib/deviceId'

let uploader: string | undefined

/**
 * 画布上传声明里记的「谁在传」：按标签页区分，而不只是按浏览器。
 * 同一浏览器开两个标签页时 getDeviceId() 相同，但原图只在加图的那个标签页内存里；
 * 用设备 ID 加本页随机后缀，另一个标签页才会把它当成别处在传，而不是自己缺图或重复上传。
 */
export function getCanvasUploaderId(): string {
  uploader ??= `${getDeviceId()}:${crypto.randomUUID().slice(0, 8)}`
  return uploader
}
