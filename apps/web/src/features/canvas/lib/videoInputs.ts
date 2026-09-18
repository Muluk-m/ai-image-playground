import type { VideoGenerationRecord, VideoRequest } from '@image-playground/shared'
import type { CanvasInputEntry } from './rasterizeSelection'

/** 一张输入图在这段视频里的用法。 */
export type VideoInputRole = 'first' | 'last' | 'reference'

export interface VideoInputItem {
  entry: CanvasInputEntry
  role: VideoInputRole
}

type GenerationInputs = Pick<VideoGenerationRecord, 'firstFrameId' | 'lastFrameId' | 'referenceIds'>

/** 「选中即参考」的初始面板：按画布从左到右，默认都当参考图，首尾帧由用户标。 */
export function defaultInputItems(entries: readonly CanvasInputEntry[]): VideoInputItem[] {
  return [...entries]
    .sort((a, b) => a.box.x - b.box.x)
    .map((entry) => ({ entry, role: 'reference' }))
}

/** 首帧、尾帧各只有一张：标给另一张时，原来那张退回参考图。 */
export function setInputRole(
  items: readonly VideoInputItem[],
  index: number,
  role: VideoInputRole,
): VideoInputItem[] {
  return items.map((item, at) => {
    if (at === index) return { ...item, role }
    if (role !== 'reference' && item.role === role) return { ...item, role: 'reference' }
    return item
  })
}

export function moveInputItem(
  items: readonly VideoInputItem[],
  from: number,
  to: number,
): VideoInputItem[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved) next.splice(to, 0, moved)
  return next
}

/** 面板写进生成记录的那几项；参考图保持面板顺序。 */
export function generationInputs(items: readonly VideoInputItem[]): GenerationInputs {
  const first = items.find((item) => item.role === 'first')
  const last = items.find((item) => item.role === 'last')
  const references = items.filter((item) => item.role === 'reference')
  return {
    ...(first ? { firstFrameId: first.entry.imageId } : {}),
    ...(last ? { lastFrameId: last.entry.imageId } : {}),
    ...(references.length ? { referenceIds: references.map((item) => item.entry.imageId) } : {}),
  }
}

/**
 * 输入图的提交顺序：首帧、尾帧、参考图。队列请求的下标与重新生成都按这一个顺序，
 * 改顺序就得两处一起改，所以只写在这里。
 */
export function generationInputIds(record: GenerationInputs): string[] {
  return [
    ...(record.firstFrameId ? [record.firstFrameId] : []),
    ...(record.lastFrameId ? [record.lastFrameId] : []),
    ...(record.referenceIds ?? []),
  ]
}

export function inputIndices(
  record: GenerationInputs,
): Pick<VideoRequest, 'first_frame_index' | 'last_frame_index' | 'reference_image_indices'> {
  let next = 0
  const first = record.firstFrameId ? next++ : undefined
  const last = record.lastFrameId ? next++ : undefined
  const references = (record.referenceIds ?? []).map(() => next++)
  return {
    ...(first !== undefined ? { first_frame_index: first } : {}),
    ...(last !== undefined ? { last_frame_index: last } : {}),
    ...(references.length ? { reference_image_indices: references } : {}),
  }
}
