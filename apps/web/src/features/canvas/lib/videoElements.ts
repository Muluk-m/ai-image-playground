import { queueOutputUrl } from '../../video/lib/playback'
import type { CanvasEditor } from './editor'

/** 画布上的一个可播放对象。位图是封面，片子在服务端。 */
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
    if (element.type !== 'image' || !element.video) continue
    videos.push({
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      url: queueOutputUrl(element.video.taskId, element.video.outputIndex),
    })
  }
  return videos
}
