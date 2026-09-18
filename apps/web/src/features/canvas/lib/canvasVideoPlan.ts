import type { VideoModelSupport } from '@image-playground/shared'
import type { CanvasInputEntry } from './rasterizeSelection'

/** 选区里的一项：图片条目，以及它是不是一段视频的封面。 */
export interface CanvasVideoCandidate {
  entry: CanvasInputEntry
  video: boolean
}

export type CanvasVideoRefusal =
  | 'videoSelected'
  | 'tooManyImages'
  | 'firstFrameUnsupported'
  | 'lastFrameUnsupported'

export type CanvasVideoPlan =
  | { ok: true; frames: CanvasInputEntry[] }
  | { ok: false; reason: CanvasVideoRefusal }

/**
 * 视频档怎么读选区：没图是文生，一张是首帧，两张按画布上从左到右当首帧与尾帧。
 * 模型接不住的图一律拒绝并说明，不静默丢——少了尾帧的片子和用户要的不是一回事。
 * 选中的视频不当作图：它的续写与改写在视频自己的工具条上。
 */
export function planVideoFrames(
  candidates: readonly CanvasVideoCandidate[],
  support: VideoModelSupport,
): CanvasVideoPlan {
  if (candidates.some((one) => one.video)) return { ok: false, reason: 'videoSelected' }
  if (candidates.length > 2) return { ok: false, reason: 'tooManyImages' }
  if (candidates.length > 0 && !support.firstFrame)
    return { ok: false, reason: 'firstFrameUnsupported' }
  if (candidates.length > 1 && !support.lastFrame)
    return { ok: false, reason: 'lastFrameUnsupported' }
  const frames = candidates.map((one) => one.entry).sort((a, b) => a.box.x - b.box.x)
  return { ok: true, frames }
}
