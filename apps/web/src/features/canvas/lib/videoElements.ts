import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { CanvasEditor } from './editor'

/**
 * 画布上的视频对象就是一张图片元素：位图是封面，mp4 留在服务端。
 * 播放来源记在 meta 里而不是整条 URL——部署换了源，存档里的地址就死了。
 */
const TASK_KEY = 'videoTaskId'
const OUTPUT_KEY = 'videoOutputIndex'

export interface CanvasVideoSource {
  readonly taskId: string
  readonly outputIndex: number
}

export function videoElementMeta(source: CanvasVideoSource): Record<string, string> {
  return { [TASK_KEY]: source.taskId, [OUTPUT_KEY]: String(source.outputIndex) }
}

export interface CanvasVideo {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rotation: number
  readonly url: string
}

export function canvasVideos(editor: CanvasEditor): CanvasVideo[] {
  const videos: CanvasVideo[] = []
  for (const element of editor.getElements()) {
    if (element.type !== 'image') continue
    const taskId = element.meta?.[TASK_KEY]
    const outputIndex = element.meta?.[OUTPUT_KEY]
    if (!taskId || outputIndex === undefined) continue
    videos.push({
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      url: `${bffBaseUrl()}/v1/queue/requests/${taskId}/output/${outputIndex}`,
    })
  }
  return videos
}
