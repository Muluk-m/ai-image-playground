import {
  nextVideoKeyframeTimestamp,
  type VideoGenerationRecord,
  type VideoRequest,
} from '@image-playground/shared'
import type { CanvasInputEntry } from './rasterizeSelection'

/** 一张输入图在这段视频里的用法。 */
export type VideoInputRole = 'first' | 'last' | 'reference' | 'keyframe'

export interface VideoInputItem {
  entry: CanvasInputEntry
  role: VideoInputRole
  /** 关键帧在成片里的秒数。其它角色没有这一项。 */
  timestampSeconds?: number
}

export type GenerationInputs = Pick<
  VideoGenerationRecord,
  'firstFrameId' | 'lastFrameId' | 'referenceIds' | 'keyframes' | 'voices'
>

/** 「选中即参考」的初始面板：按画布从左到右，默认都当参考图，首尾帧由用户标。 */
export function defaultInputItems(entries: readonly CanvasInputEntry[]): VideoInputItem[] {
  return [...entries]
    .sort((a, b) => a.box.x - b.box.x)
    .map((entry) => ({ entry, role: 'reference' }))
}

const KEYFRAME_MAX = 4

/**
 * 首帧、尾帧各只有一张：标给另一张时，原来那张退回参考图。
 * 关键帧可以有多张，到上限就不再加；新标上的给一个还空着的时间。
 */
export function setInputRole(
  items: readonly VideoInputItem[],
  index: number,
  role: VideoInputRole,
  durationSeconds = 5,
): VideoInputItem[] {
  if (role === 'keyframe') {
    const keyframes = items.filter((item) => item.role === 'keyframe').length
    if (items[index]?.role !== 'keyframe' && keyframes >= KEYFRAME_MAX) return [...items]
  }
  return items.map((item, at) => {
    if (at === index) {
      if (role !== 'keyframe') return { entry: item.entry, role }
      const timestampSeconds =
        item.timestampSeconds ??
        nextVideoKeyframeTimestamp(
          durationSeconds,
          items.flatMap((one, oneAt) =>
            oneAt !== index && one.role === 'keyframe' && one.timestampSeconds !== undefined
              ? [one.timestampSeconds]
              : [],
          ),
        ) ??
        undefined
      return timestampSeconds === undefined ? item : { entry: item.entry, role, timestampSeconds }
    }
    if ((role === 'first' || role === 'last') && item.role === role)
      return { entry: item.entry, role: 'reference' }
    return item
  })
}

export function setKeyframeTimestamp(
  items: readonly VideoInputItem[],
  index: number,
  timestampSeconds: number,
): VideoInputItem[] {
  return items.map((item, at) => (at === index ? { ...item, timestampSeconds } : item))
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
  const keyframes = items.filter(
    (item): item is VideoInputItem & { timestampSeconds: number } =>
      item.role === 'keyframe' && item.timestampSeconds !== undefined,
  )
  return {
    ...(first ? { firstFrameId: first.entry.imageId } : {}),
    ...(last ? { lastFrameId: last.entry.imageId } : {}),
    ...(references.length ? { referenceIds: references.map((item) => item.entry.imageId) } : {}),
    ...(keyframes.length
      ? {
          keyframes: keyframes.map((item) => ({
            imageId: item.entry.imageId,
            timestampSeconds: item.timestampSeconds,
          })),
        }
      : {}),
  }
}

/** 从一条生成记录里取出输入图那几项（首尾帧与参考图）。 */
export function pickGenerationInputs(record: GenerationInputs): GenerationInputs {
  return {
    ...(record.firstFrameId ? { firstFrameId: record.firstFrameId } : {}),
    ...(record.lastFrameId ? { lastFrameId: record.lastFrameId } : {}),
    ...(record.referenceIds?.length ? { referenceIds: [...record.referenceIds] } : {}),
    ...(record.keyframes?.length
      ? {
          keyframes: record.keyframes.map((frame) => ({
            imageId: frame.imageId,
            timestampSeconds: frame.timestampSeconds,
          })),
        }
      : {}),
    ...(record.voices?.length ? { voices: [...record.voices] } : {}),
  }
}

/**
 * 输入图的提交顺序：首帧、尾帧、参考图、关键帧。队列请求的下标与重新生成都按这一个顺序，
 * 改顺序就得两处一起改，所以只写在这里。
 */
export function generationInputIds(record: GenerationInputs): string[] {
  return [
    ...(record.firstFrameId ? [record.firstFrameId] : []),
    ...(record.lastFrameId ? [record.lastFrameId] : []),
    ...(record.referenceIds ?? []),
    ...(record.keyframes ?? []).map((frame) => frame.imageId),
  ]
}

export function inputIndices(
  record: GenerationInputs,
): Pick<
  VideoRequest,
  'first_frame_index' | 'last_frame_index' | 'reference_image_indices' | 'keyframes'
> {
  let next = 0
  const first = record.firstFrameId ? next++ : undefined
  const last = record.lastFrameId ? next++ : undefined
  const references = (record.referenceIds ?? []).map(() => next++)
  const keyframes = (record.keyframes ?? []).map((frame) => ({
    image_index: next++,
    timestamp_seconds: frame.timestampSeconds,
  }))
  return {
    ...(first !== undefined ? { first_frame_index: first } : {}),
    ...(last !== undefined ? { last_frame_index: last } : {}),
    ...(references.length ? { reference_image_indices: references } : {}),
    ...(keyframes.length ? { keyframes } : {}),
  }
}
