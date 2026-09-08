import { authenticatedBffFetch } from '../../../lib/authClient'
import { downloadBlob } from '../../../lib/downloadImages'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { storeImageFromUrl, useStore } from '../../../store'
import { useLibraryStore } from '../../library/store'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'

/** 播放与下载都打这个地址；mp4 不落 IndexedDB。 */
export function videoOutputUrl(task: VideoTask): string | null {
  if (!task.bffRequestId || task.outputIndex === undefined) return null
  return `${bffBaseUrl()}/v1/queue/requests/${task.bffRequestId}/output/${task.outputIndex}`
}

export function clockLabel(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function videoFileName(task: VideoTask): string {
  const slug = task.prompt
    .trim()
    .slice(0, 20)
    .replace(/[\\/:*?"<>|\s]+/g, '-')
  return `${slug || 'video'}-${task.duration}s.mp4`
}

export async function downloadVideoTask(task: VideoTask): Promise<void> {
  const url = videoOutputUrl(task)
  if (!url) throw new Error('这条还没有可下载的视频')
  const res = await authenticatedBffFetch(url)
  if (!res.ok) throw new Error(`视频拉取失败：${res.status}`)
  downloadBlob(await res.blob(), videoFileName(task))
}

/** 跨域视频没配好 CORS 时 canvas 会被污染，toDataURL 直接抛。 */
export function captureVideoFrame(video: HTMLVideoElement): string | null {
  const { videoWidth: width, videoHeight: height } = video
  if (!width || !height) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.7)
  } catch {
    return null
  }
}

export async function adoptAsFirstFrame(dataUrl: string): Promise<void> {
  const { id } = await storeImageFromUrl(dataUrl)
  useVideoStore.getState().useAsFirstFrame(id)
}

/** 图片侧的「做成视频」：填首帧并切到视频模式，沿途关掉挡住 composer 的浮层。 */
export function startVideoFromImage(imageId: string): void {
  useVideoStore.getState().useAsFirstFrame(imageId)
  const main = useStore.getState()
  main.setAppMode('video')
  main.setLightboxImageId(null)
  main.setDetailTaskId(null)
  useLibraryStore.getState().closePanel()
}
