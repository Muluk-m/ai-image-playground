import { authenticatedBffFetch } from '../../../lib/authClient'
import { downloadBlob } from '../../../lib/downloadImages'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { storeImageFromUrl } from '../../../store'
import { useVideoStore } from '../store'
import type { VideoTask } from '../types'

/** 队列产出的字节地址；mp4 不落 IndexedDB，播放与下载都打这里。 */
export function queueOutputUrl(taskId: string, outputIndex: number): string {
  return `${bffBaseUrl()}/v1/queue/requests/${taskId}/output/${outputIndex}`
}

export function videoOutputUrl(task: VideoTask): string | null {
  if (!task.bffRequestId || task.outputIndex === undefined) return null
  return queueOutputUrl(task.bffRequestId, task.outputIndex)
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

export interface VideoDownloadProgress {
  received: number
  /** 上游给了 content-length 才有总量，否则只能报已收字节。 */
  total: number | null
}

export function downloadProgressLabel({ received, total }: VideoDownloadProgress): string {
  if (total) return `下载中 ${Math.min(100, Math.round((received / total) * 100))}%`
  return `下载中 ${(received / 1_048_576).toFixed(1)} MB`
}

async function readWithProgress(
  res: Response,
  onProgress?: (progress: VideoDownloadProgress) => void,
): Promise<Blob> {
  const reader = res.body?.getReader()
  // 少数网关不给可读流，只能整块取——这条路径没有进度可报。
  if (!reader) return res.blob()
  const total = Number(res.headers.get('content-length')) || null
  const chunks: Uint8Array[] = []
  let received = 0
  let reported = ''
  // 按文案去重：每块都上报会让一个 30MB 视频重渲染近千次，其中九成画面一模一样。
  const report = () => {
    const label = downloadProgressLabel({ received, total })
    if (label === reported) return
    reported = label
    onProgress?.({ received, total })
  }
  report()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    report()
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? '' })
}

export async function downloadVideoTask(
  task: VideoTask,
  options: {
    onProgress?: (progress: VideoDownloadProgress) => void
    signal?: AbortSignal
  } = {},
): Promise<void> {
  const url = videoOutputUrl(task)
  if (!url) throw new Error('这条还没有可下载的视频')
  const res = await authenticatedBffFetch(url, { signal: options.signal })
  if (!res.ok) throw new Error(`视频拉取失败：${res.status}`)
  downloadBlob(await readWithProgress(res, options.onProgress), videoFileName(task))
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
